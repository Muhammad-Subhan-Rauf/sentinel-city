"""
Core async agent script for Sentinel-City AI Orchestrator.
Runs the Detection (Loop A) and Monitoring (Loop B) loops.

The two loops are now LangGraph ReAct agents (built in ``main()`` via
``agent_graph.build_agent``) that invoke ``@tool``-decorated functions from
``agent_tools.build_tools``. The outer shell here only handles polling,
fingerprinting (to skip Gemini calls when the world hasn't changed), 429
back-off, and DECISION-level audit logging — the agents themselves drive
the multi-step tool-use loop internally.
"""

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

from google import genai
from google.genai import types
from google.genai import errors as genai_errors
from langchain_core.messages import HumanMessage

# Project-local imports MUST come before any function definitions below that
# reference these names in type annotations — Python evaluates annotations at
# def-time, so a misplaced import here raises NameError at module load.
from api_client import SentinelAPIClient
from state import AgentState, IncidentState
from audit import AuditLogger
from agent_tools import build_tools, make_tool_invoker
from agent_graph import build_agent, count_tool_calls, extract_final_text
from cache import agent_cache
from safety import sla as _sla
from wake_bus import WakeBus

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"


# Models tried in order. First one is the preferred quality; each fallback
# has its own quota bucket on the Generative Language API, so when one fails
# with 429 (quota) or 5xx (high demand) the next is usually still available.
GEMINI_MODEL_FALLBACK = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
]

# Transient error codes that should trigger a fallback to the next model.
_FALLBACK_STATUS_CODES = {429, 500, 502, 503, 504}


async def generate_with_fallback(
    client: genai.Client,
    contents: Any,
    config: types.GenerateContentConfig,
    label: str = "Gemini",
) -> Any:
    """Try each model in GEMINI_MODEL_FALLBACK until one succeeds.

    On a transient error (429/5xx), log and try the next model. On a
    non-transient error (auth, malformed request), raise immediately so
    we surface the real bug instead of cascading through every model.
    On full exhaustion, raise the last transient error.
    """
    last_err: Optional[Exception] = None
    for model in GEMINI_MODEL_FALLBACK:
        try:
            resp = await client.aio.models.generate_content(
                model=model,
                contents=contents,
                config=config,
            )
            if last_err is not None:
                logger.info(f"[{label}] Recovered using fallback model {model}")
            return resp
        except (genai_errors.ClientError, genai_errors.ServerError) as e:
            code = getattr(e, "code", None)
            if code not in _FALLBACK_STATUS_CODES:
                raise  # auth / validation — no point trying other models
            last_err = e
            logger.warning(f"[{label}] {model} returned {code}; trying next fallback")
            continue
    # All models exhausted; re-raise the last error so the existing
    # loop-level handler (429 sleep, etc.) still runs.
    assert last_err is not None
    raise last_err


# Keywords that mark a citizen report as high-signal even if no disaster
# record exists for it yet. Catches the "new urgent report, no incident
# declared" blind spot in the count-based fingerprint (plan §1.2 fix).
_HIGH_SIGNAL_KEYWORDS = (
    "fire", "smoke", "flame", "burning",
    "injur", "blood", "unconscious", "dying", "dead", "trapped",
    "shot", "shoot", "stabbed", "weapon", "gun",
    "collapse", "explosion", "blast",
    "flood", "drowning",
    "emergency",
)


def _is_high_signal_report(r: Dict[str, Any]) -> bool:
    """Heuristic: a citizen report worth re-running the agent for."""
    urgency = str(r.get("urgency", "")).lower()
    if urgency in {"high", "critical"}:
        return True
    sev = str(r.get("perceived_severity", "")).lower()
    if sev in {"high", "critical"}:
        return True
    transcript = (str(r.get("transcript", "")) + " " + str(r.get("report_kind", ""))).lower()
    return any(kw in transcript for kw in _HIGH_SIGNAL_KEYWORDS)


def _signal_fingerprint(disasters: Any, reports: Any, state: AgentState) -> str:
    """Cheap dedup key. Skip Gemini call when this matches the previous tick.

    v2 (plan §1.2): also includes a count of high-signal citizen reports so a
    new "fire downtown" report that doesn't yet have a disaster record still
    triggers a tick. Without this we have a silent-fail blind spot.
    """
    def _listify(x: Any) -> list:
        if isinstance(x, list):
            return x
        if isinstance(x, dict) and isinstance(x.get("disasters"), list):
            return x["disasters"]
        if isinstance(x, dict) and isinstance(x.get("reports"), list):
            return x["reports"]
        return []

    d_list = _listify(disasters)
    r_list = _listify(reports)
    incident_keys = sorted(state.active_incidents.keys()) if hasattr(state, "active_incidents") else []

    def _last(items: list, *keys: str) -> str:
        if not items:
            return ""
        # Pick the last by id-as-string for stable ordering without timestamps.
        last = sorted(items, key=lambda x: str(x.get("id") or x.get("event_id") or ""))[-1]
        return "|".join(str(last.get(k, "")) for k in keys)

    high_signal_count = sum(1 for r in r_list if isinstance(r, dict) and _is_high_signal_report(r))

    return "::".join([
        f"d={len(d_list)}",
        f"r={len(r_list)}",
        f"hs={high_signal_count}",  # v2: high-signal report count
        f"a={','.join(incident_keys)}",
        f"d_last={_last(d_list, 'id', 'status', 'severity')}",
        f"r_last={_last(r_list, 'event_id', 'reported_at')}",
    ])


def _extract_retry_delay_seconds(err: Exception) -> Optional[float]:
    """Pull retryDelay (e.g. '54s') out of a google-genai ClientError, if present."""
    details = getattr(err, "details", None)
    payload = None
    if isinstance(details, dict):
        payload = details
    else:
        msg = str(err)
        m = re.search(r"'retryDelay':\s*'([^']+)'", msg)
        if m:
            raw = m.group(1)
            try:
                return float(raw.rstrip("s"))
            except ValueError:
                return None
    if payload:
        for d in payload.get("error", {}).get("details", []):
            if d.get("@type", "").endswith("RetryInfo"):
                raw = d.get("retryDelay", "")
                try:
                    return float(str(raw).rstrip("s"))
                except ValueError:
                    return None
    return None

async def load_prompt(filename: str) -> str:
    """Load a prompt string from the prompts directory."""
    filepath = PROMPTS_DIR / filename
    if not filepath.exists():
        logger.warning(f"Prompt file {filename} not found at {filepath}.")
        return ""
    return filepath.read_text(encoding="utf-8")

def _scrub_disasters_for_agent(disasters: Any) -> Any:
    """Strip ground-truth geometry from the disaster list before passing to
    the agent. AI knows an incident exists (id, type, severity, status) but
    not where exactly it is — that's what triangulate_incident is for."""
    def _scrub_one(d: Dict[str, Any]) -> Dict[str, Any]:
        return {
            k: v for k, v in d.items()
            if k not in {"area_geometry", "geometry", "coordinates", "lat", "lng"}
        }
    if isinstance(disasters, list):
        return [_scrub_one(d) for d in disasters if isinstance(d, dict)]
    if isinstance(disasters, dict) and isinstance(disasters.get("disasters"), list):
        return {**disasters, "disasters": [_scrub_one(d) for d in disasters["disasters"] if isinstance(d, dict)]}
    return disasters


def sync_state_with_disasters(state: AgentState, disasters: Any):
    """
    Synchronizes the local agent state with active disasters from the API.
    """
    if isinstance(disasters, dict) and "disasters" in disasters:
        disasters_list = disasters["disasters"]
    elif isinstance(disasters, list):
        disasters_list = disasters
    else:
        disasters_list = []

    active_disaster_ids = set()
    for d in disasters_list:
        # We only care about active disasters
        if d.get("status") != "active":
            continue
            
        disaster_id = d["id"]
        active_disaster_ids.add(disaster_id)
        
        # Get coordinates
        lng, lat = 0.0, 0.0
        geom = d.get("area_geometry")
        if geom and isinstance(geom, dict):
            coords = geom.get("coordinates")
            if coords and len(coords) >= 2:
                lng, lat = coords[0], coords[1]
                
        # Determine severity string from number (or just keep string severity)
        sev_val = d.get("severity", 4)
        if isinstance(sev_val, str):
            severity_str = sev_val
        else:
            if sev_val >= 8:
                severity_str = "critical"
            elif sev_val >= 6:
                severity_str = "high"
            elif sev_val >= 4:
                severity_str = "medium"
            else:
                severity_str = "low"
            
        # The fire_sighted correction path POSTs disaster_events.location_estimate
        # server-side. Pull that into the AI-visible cache so subsequent dispatches
        # use the corrected coords without needing another triangulation pass.
        api_loc_estimate = d.get("location_estimate")

        if disaster_id not in state.active_incidents:
            # Create a new IncidentState
            incident = IncidentState(
                incident_id=disaster_id,
                type=d.get("disaster_type", "unknown").lower(),
                location={"lat": lat, "lng": lng},
                location_estimate=api_loc_estimate if isinstance(api_loc_estimate, dict) else None,
                severity=severity_str,
                confidence=1.0,
                description=d.get("notes", "") or "",
                status="active"
            )
            state.add_incident(incident)
        else:
            # Update existing IncidentState
            state.update_incident(
                disaster_id,
                severity=severity_str,
                description=d.get("notes", "") or ""
            )
            # Refresh location_estimate from API if the server just corrected it.
            if isinstance(api_loc_estimate, dict) and api_loc_estimate.get("lat") is not None:
                incident = state.active_incidents.get(disaster_id)
                if incident is not None:
                    incident.location_estimate = api_loc_estimate
            
    # Remove any incidents from state that are no longer active in the backend
    for d_id in list(state.active_incidents.keys()):
        if d_id not in active_disaster_ids:
            state.remove_incident(d_id)


# Hard cap on LLM ↔ tool cycles inside a single agent.ainvoke. LangGraph's
# default recursion_limit is 25, which on the free-tier 20-RPD quota burns a
# whole day's budget in one tick. Bumped from 6 to 12 once the AI started
# routinely doing triangulate → dispatch → cordon → alert in one turn —
# 6 cycles ran out before the AI finished the sequence and the loop went
# silent ("Sorry, need more steps...").
_AGENT_RECURSION_LIMIT = 12

# Outer loop sleep. Bumped from 60s after observing the agent burn through
# free-tier daily quota inside ~5 minutes during a busy demo.
_LOOP_SLEEP_SECONDS = 90

# Wall-clock cap per agent.ainvoke. A single Gemini call usually returns in
# 1-3s; an entire ReAct trace inside one tick should finish well under 60s.
# Hitting this means Vertex is in a degraded state — bail and let the next
# tick try with fresh state, instead of holding up the whole loop.
_AGENT_TIMEOUT_SECONDS = float(os.environ.get("SENTINEL_AGENT_TIMEOUT", "60"))


# Set by main()/lifespan once tools are built. Used by _invoke_agent to
# replay cached tool-call plans without re-prompting Gemini (plan §1.1).
_TOOL_INVOKER: Optional[Any] = None


def set_tool_invoker(invoker: Any) -> None:
    """Register the (name, args)->result callable used for L1 cache replays."""
    global _TOOL_INVOKER
    _TOOL_INVOKER = invoker


async def _invoke_agent(agent: Any, label: str, system_context: Dict[str, Any]) -> Dict[str, Any]:
    """Invoke a LangGraph ReAct agent with a context dict as the user message.

    L1 cache front: if the same canonical context produced a tool plan
    recently, replay the plan via the live tool layer (still hits the
    safety pipeline) and skip the LLM. Otherwise invoke for real, store
    the resulting plan, and return the trace.

    Returns the final state dict (``{"messages": [...]}``). Exceptions
    propagate to the caller so the loop-level 429/back-off handler runs.
    Wrapped in asyncio.wait_for so a stuck Vertex call can't freeze the loop.
    """
    from metrics import inc as _metric_inc, observe as _metric_observe
    import time as _time

    # L1 exact-match cache
    if _TOOL_INVOKER is not None:
        cached_plan = agent_cache.lookup(label, system_context)
        if cached_plan is not None:
            logger.info(
                f"[{label}] L1 cache HIT — replaying {len(cached_plan)} tool call(s) without LLM"
            )
            return await agent_cache.replay(cached_plan, _TOOL_INVOKER, label)

    logger.info(f"[{label}] Invoking agent...")
    _metric_inc(f"agent.invoke.{label.lower()}")
    started = _time.time()
    try:
        result = await asyncio.wait_for(
            agent.ainvoke(
                {"messages": [HumanMessage(content=f"Current world state:\n{system_context}")]},
                config={"recursion_limit": _AGENT_RECURSION_LIMIT},
            ),
            timeout=_AGENT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        _metric_inc(f"agent.timeout.{label.lower()}")
        logger.warning(
            f"[{label}] agent.ainvoke timed out after {_AGENT_TIMEOUT_SECONDS:.0f}s; "
            "returning empty trace so the next tick re-prompts with fresh state"
        )
        return {"messages": []}
    finally:
        _metric_observe(f"agent.latency_seconds.{label.lower()}", _time.time() - started)
    logger.info(f"[{label}] Agent returned with {len(result.get('messages', []))} messages")

    # Cache the plan for the next identical context
    agent_cache.store(label, system_context, result.get("messages", []))
    return result


async def detection_loop(
    api: SentinelAPIClient,
    state: AgentState,
    audit: AuditLogger,
    client: genai.Client,
    agent: Any,
):
    """Loop A (Detection): scan signals, invoke the detection ReAct agent.

    The agent (built in ``main()``) internally drives the LLM → tool → LLM
    loop. We only handle the outer cycle: poll, fingerprint, invoke, audit.
    """
    logger.info("Starting detection_loop (Loop A, event-driven)")
    bus = WakeBus.for_label("detection")
    last_fingerprint: Optional[str] = None

    while True:
        try:
            # Sleep until something interesting happens: citizen call(s),
            # weather/traffic change, SLA breach, or the periodic fallback
            # heartbeat. Token spend is dominated by the cost of skipping
            # this wait — no wake, no LLM call.
            wakeup = await bus.next_wakeup()
            logger.info(f"[Detection] Woken: {wakeup.summary()}")

            disasters = await api.get_disasters()
            sync_state_with_disasters(state, disasters)
            weather = await api.get_weather()
            traffic = await api.get_traffic()
            reports = await api.get_citizen_reports()

            # Defense-in-depth: fingerprint dedup still applies, in case the
            # wake-up came from a spurious source. SLA still forces.
            forced = _sla.should_force_tick("detection") or wakeup.fallback
            fingerprint = _signal_fingerprint(disasters, reports, state)
            if not forced and fingerprint == last_fingerprint:
                logger.info("[Detection] Wake fired but world fingerprint unchanged; skipping agent invocation.")
                continue
            if forced and wakeup.fallback:
                logger.info("[Detection] Periodic heartbeat tick")

            context = {
                "wake_reason": wakeup.summary(),
                "active_incidents": {k: v.agent_view() for k, v in state.active_incidents.items()},
                "signals": {
                    "disasters": _scrub_disasters_for_agent(disasters),
                    "weather": weather,
                    "traffic": traffic,
                    "reports": reports,
                },
                "instruction": (
                    "Ground-truth incident locations are NOT in this payload. "
                    "Call triangulate_incident(incident_id=...) before any dispatch / cordon. "
                    "Call triangulate_incident(search_bbox=...) to localize emerging incidents."
                ),
            }

            result = await _invoke_agent(agent, "Detection", context)
            messages = result.get("messages", [])
            tool_calls_made = count_tool_calls(messages)

            # Bug #2 fix: only advance the fingerprint when the agent actually
            # acted. A text-only response (e.g. "Would you like me to proceed?")
            # leaves the gate open so the next tick re-prompts.
            if tool_calls_made > 0:
                last_fingerprint = fingerprint
                _sla.track_productive_tick("detection")
                logger.info(f"[Detection] Agent executed {tool_calls_made} tool call(s).")
            else:
                logger.warning(
                    "[Detection] Agent returned 0 tool calls; NOT advancing fingerprint."
                )
                audit.log_recovery_action(
                    state.agent_id,
                    "detection_loop: agent returned 0 tool calls",
                    "Leaving fingerprint un-advanced so the next tick re-prompts.",
                )

            # If the agent had a final text answer, capture it as an OBSERVATION
            # — matches the previous behavior for "world looks quiet" turns.
            final_text = extract_final_text(messages)
            if final_text:
                audit.log_observation(
                    agent_id=state.agent_id,
                    source="detection_loop",
                    data=final_text,
                )

        except Exception as e:
            logger.error(f"Error in detection_loop: {e}", exc_info=True)
            audit.log_recovery_action(state.agent_id, f"detection_loop error: {e}", "Wait and retry")
            if isinstance(e, genai_errors.ClientError) and getattr(e, "code", None) == 429:
                delay = _extract_retry_delay_seconds(e) or 30.0
                logger.warning(f"[Detection] Gemini 429 — sleeping {delay:.0f}s before retry")
                await asyncio.sleep(delay)
                # fall through to next iteration; bus.next_wakeup handles
                # the "wait for something to happen" semantics
                continue


async def monitoring_supervisor(
    api: SentinelAPIClient,
    state: AgentState,
    audit: AuditLogger,
    client: genai.Client,
    agent: Any,
):
    """Loop B (Monitoring): manage active incidents via the monitoring agent.

    The monitoring agent is built with ``force_tool_use=True`` so Gemini is
    required to call SOME tool every turn — closing the chat-mode escape
    hatch that caused the "Would you like me to proceed?" bug.
    """
    logger.info("Starting monitoring_supervisor (Loop B, event-driven)")
    bus = WakeBus.for_label("monitoring")
    last_fingerprint: Optional[str] = None

    while True:
        try:
            wakeup = await bus.next_wakeup()
            logger.info(f"[Monitoring] Woken: {wakeup.summary()}")

            disasters = await api.get_disasters()
            sync_state_with_disasters(state, disasters)

            if not state.active_incidents:
                last_fingerprint = None  # reset so a fresh incident triggers a call
                logger.info("[Monitoring] No active incidents; nothing to do.")
                continue

            forced = _sla.should_force_tick("monitoring") or wakeup.fallback
            fingerprint = _signal_fingerprint(disasters, [], state)
            if not forced and fingerprint == last_fingerprint:
                logger.info("[Monitoring] Wake fired but world fingerprint unchanged; skipping agent invocation.")
                continue
            if forced and wakeup.fallback:
                logger.info("[Monitoring] Periodic heartbeat tick on active incidents")

            # Responder field reports (casualty + fire_sighted corrections).
            # Best-effort — endpoint may be absent on older deployments.
            try:
                responder_payload = await api.get_responder_reports(status="pending")
                pending_responder_reports = (responder_payload or {}).get("reports", [])
            except Exception as _rr_exc:
                logger.debug(f"[Monitoring] responder reports unavailable: {_rr_exc}")
                pending_responder_reports = []

            # Pre-triangulate server-side for any active incident that has no
            # location_estimate yet. Saves the AI from having to spend
            # recursion cycles on triangulate→dispatch loops. The dispatch
            # gate still refuses if there's truly no citizen signal, but the
            # common case (signal exists, AI just hasn't called triangulate)
            # is handled here before the AI ever sees the context.
            from routing.triangulation import triangulate as _bg_triangulate
            for inc_id, inc in state.active_incidents.items():
                if getattr(inc, "location_estimate", None):
                    continue
                try:
                    await _bg_triangulate(api, incident_id=inc_id, state=state)
                except Exception as _tr_exc:
                    logger.debug(f"[Monitoring] pre-triangulate for {inc_id} failed: {_tr_exc}")

            # Pre-rank fire stations per incident so the AI doesn't have to do
            # haversine arithmetic — LLMs are unreliable at geographic math.
            # Uses the incident's location_estimate when present (now usually
            # set by the pre-triangulate above), falling back to ground-truth
            # `location` for stations-list completeness. The AI only consumes
            # the ranked station list, never the source coordinates.
            nearest_fire_stations_per_incident: Dict[str, Any] = {}
            for inc_id, inc in state.active_incidents.items():
                est = getattr(inc, "location_estimate", None) or getattr(inc, "location", None) or {}
                try:
                    elat = float(est.get("lat"))
                    elng = float(est.get("lng"))
                except (TypeError, ValueError, AttributeError):
                    continue
                if abs(elat) < 0.001 and abs(elng) < 0.001:
                    continue
                try:
                    nearest = await api.get_nearest_resources(elat, elng, kind="fire_station", limit=3)
                    nearest_fire_stations_per_incident[inc_id] = nearest.get("resources", [])
                except Exception as _ne_exc:
                    logger.debug(f"[Monitoring] nearest_fire_stations for {inc_id} failed: {_ne_exc}")

            context = {
                "wake_reason": wakeup.summary(),
                "active_incidents": {k: v.agent_view() for k, v in state.active_incidents.items()},
                "fire_stations": await api.get_fire_stations(),
                "police_stations": await api.get_police_stations(),
                "hospitals": await api.get_hospitals(),
                "cordons": await api.get_cordons(),
                "traffic": await api.get_traffic(),
                "weather": await api.get_weather(),
                "recent_reports": await api.get_citizen_reports(),
                "recent_responder_reports": pending_responder_reports,
                "nearest_fire_stations_per_incident": nearest_fire_stations_per_incident,
                "instruction": (
                    "Dispatch heuristics (follow strictly to keep LLM cycles low):\n"
                    "• AMBULANCES are auto-dispatched server-side when casualty reports "
                    "arrive — recent_responder_reports.casualty_* entries are INFORMATIONAL. "
                    "Do NOT call dispatch_units(unit_type='ambulance') for them; the system "
                    "already has.\n"
                    "• FIRE TRUCKS: for each active wildfire/building_fire/flood, pick "
                    "station_id = nearest_fire_stations_per_incident[<incident_id>][0].id "
                    "(pre-sorted by distance + available capacity). Scale count by severity: "
                    "low=1, medium=2-3, high=4, critical=5-6. Floods are fought the same way "
                    "as fires — firefighters shrink any spreading zone.\n"
                    "• Incident locations: prefer active_incidents[*].location_estimate "
                    "when present. Only call triangulate_incident when location_estimate is "
                    "null. Never triangulate a responder-report location — already precise.\n"
                    "• Before declare_incident: check active_incidents. If any active "
                    "incident is within ~1km of where you'd declare, DO NOT declare — "
                    "the server dedups same-type incidents within 800m, you'd just waste "
                    "a cycle.\n"
                    "• fire_sighted reports with is_correction=true: location_estimate was "
                    "already corrected for you and en-route units redirected. Just "
                    "acknowledge in an update_incident note if useful."
                ),
            }

            result = await _invoke_agent(agent, "Monitoring", context)
            messages = result.get("messages", [])
            tool_calls_made = count_tool_calls(messages)

            if tool_calls_made > 0:
                last_fingerprint = fingerprint
                _sla.track_productive_tick("monitoring")
                logger.info(f"[Monitoring] Agent executed {tool_calls_made} tool call(s).")
            else:
                # Bug #1 belt-and-suspenders: monitoring agent has incidents to
                # manage but emitted no tool calls. Don't burn the fingerprint;
                # log a recovery action and let the next tick re-prompt.
                logger.warning(
                    "[Monitoring] Agent returned 0 tool calls despite active incidents; "
                    "NOT advancing fingerprint."
                )
                audit.log_recovery_action(
                    state.agent_id,
                    "monitoring_supervisor: agent returned 0 tool calls with active incidents",
                    "Leaving fingerprint un-advanced so the next tick re-prompts.",
                )

            final_text = extract_final_text(messages)
            if final_text:
                audit.log_decision(
                    agent_id=state.agent_id,
                    context="monitoring_supervisor",
                    decision="Review active incidents",
                    rationale=final_text,
                )

        except Exception as e:
            logger.error(f"Error in monitoring_supervisor: {e}", exc_info=True)
            audit.log_recovery_action(state.agent_id, f"monitoring_supervisor error: {e}", "Wait and retry")
            if isinstance(e, genai_errors.ClientError) and getattr(e, "code", None) == 429:
                delay = _extract_retry_delay_seconds(e) or 30.0
                logger.warning(f"[Monitoring] Gemini 429 — sleeping {delay:.0f}s before retry")
                await asyncio.sleep(delay)
                continue


async def main():
    """Main entrypoint for the Sentinel-Core Orchestrator."""
    logger.info("Initializing Sentinel-City AI Orchestrator")

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        logger.error("GOOGLE_CLOUD_PROJECT not set — orchestrator requires Vertex AI config.")
        return
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

    # Optional: AI Studio key for the (0,0)-target-recovery helper only.
    gemini_api_key = os.environ.get("GEMINI_API_KEY")
    client = genai.Client(api_key=gemini_api_key) if gemini_api_key else None

    # Initialize SentinelCityAPI (SentinelAPIClient) and state
    api = SentinelAPIClient()
    state = AgentState(agent_id="agent-sentinel-core")
    audit = AuditLogger()

    try:
        # Update AGENT_REGISTRY on startup
        logger.info("Registering agent as online...")
        await api.update_agent('agent-sentinel-core', {'status': 'online'})

        # Build the two ReAct agents (one per loop) sharing the same toolset
        # but bound to different system prompts. force_tool_use=True on the
        # monitoring agent makes Gemini call SOME tool every turn.
        logger.info(f"Building LangGraph agents (Vertex AI: project={project}, location={location})...")
        # Register bus instances eagerly so the first POST /api/citizen-report
        # or watcher tick can push wake-ups before the loops start awaiting.
        WakeBus.for_label("detection")
        WakeBus.for_label("monitoring")

        tools_list = build_tools(api, audit, client, agent_id=state.agent_id, state=state)
        set_tool_invoker(make_tool_invoker(tools_list))
        detection_prompt = await load_prompt("detection_prompt.md")
        monitoring_prompt = await load_prompt("monitoring_prompt.md")
        detection_agent = build_agent(project, location, detection_prompt, tools_list, force_tool_use=False)
        monitoring_agent = build_agent(project, location, monitoring_prompt, tools_list, force_tool_use=True)

        logger.info("Starting background loops...")
        loop_a = asyncio.create_task(detection_loop(api, state, audit, client, detection_agent))
        loop_b = asyncio.create_task(monitoring_supervisor(api, state, audit, client, monitoring_agent))
        sla_task = _sla.start_watchdog(audit)
        from watchers import weather as _weather_watcher, traffic as _traffic_watcher
        weather_task = _weather_watcher.start(api)
        traffic_task = _traffic_watcher.start(api)

        await asyncio.gather(loop_a, loop_b, sla_task, weather_task, traffic_task)
        
    except asyncio.CancelledError:
        logger.info("Orchestrator shutting down...")
    except Exception as e:
        logger.error(f"Critical error in orchestrator: {e}", exc_info=True)
    finally:
        # Update agent status on shutdown
        try:
            logger.info("Registering agent as offline...")
            await api.update_agent('agent-sentinel-core', {'status': 'offline'})
        except Exception as e:
            logger.error(f"Failed to update agent status on shutdown: {e}")
        await api.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received. Exiting.")
