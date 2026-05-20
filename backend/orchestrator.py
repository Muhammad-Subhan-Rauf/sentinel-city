"""
Core async agent script for Sentinel-City AI Orchestrator.
Runs the Detection (Loop A) and Monitoring (Loop B) loops.
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

# Project-local imports MUST come before any function definitions below that
# reference these names in type annotations — Python evaluates annotations at
# def-time, so a misplaced import here raises NameError at module load.
from api_client import SentinelAPIClient
from state import AgentState, IncidentState
from audit import AuditLogger
import tools
from tools import ToolExecutor

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


def _signal_fingerprint(disasters: Any, reports: Any, state: AgentState) -> str:
    """Cheap dedup key. Skip Gemini call when this matches the previous tick.

    Includes counts + the latest disaster's id/status/severity + the latest
    citizen report's event_id+timestamp. Anything subtler (incident metadata
    drift) is handled by the prompts/state sync, not by triggering an extra
    Gemini call.
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

    return "::".join([
        f"d={len(d_list)}",
        f"r={len(r_list)}",
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

def get_gemini_tools() -> Optional[list]:
    """Build the google-genai tools list from the raw dicts in tools.py.

    tools.ALL_TOOLS is a list of plain dicts ({name, description, parameters}).
    GenerateContentConfig.tools expects [types.Tool(function_declarations=[...])]
    where each entry in function_declarations is a types.FunctionDeclaration.
    """
    raw: Optional[list] = None
    if hasattr(tools, "ALL_TOOLS"):
        raw = tools.ALL_TOOLS
    elif hasattr(tools, "TOOLS"):
        raw = tools.TOOLS
    elif hasattr(tools, "get_tools"):
        raw = tools.get_tools()
    if not raw:
        return None

    declarations = [types.FunctionDeclaration(**d) for d in raw]
    return [types.Tool(function_declarations=declarations)]


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
            
        if disaster_id not in state.active_incidents:
            # Create a new IncidentState
            incident = IncidentState(
                incident_id=disaster_id,
                type=d.get("disaster_type", "unknown").lower(),
                location={"lat": lat, "lng": lng},
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
            
    # Remove any incidents from state that are no longer active in the backend
    for d_id in list(state.active_incidents.keys()):
        if d_id not in active_disaster_ids:
            state.remove_incident(d_id)


async def detection_loop(api: SentinelAPIClient, state: AgentState, audit: AuditLogger, client: genai.Client):
    """
    Loop A (Detection):
    Polls the APIs, passes state to Gemini, executes its tool calls, updates state, and logs.
    """
    logger.info("Starting detection_loop (Loop A)")
    prompt = await load_prompt("detection_prompt.md")
    
    # Initialize ToolExecutor
    tool_executor = ToolExecutor(api_client=api, audit_logger=audit, gemini_client=client)
    gemini_tools = get_gemini_tools()
    last_fingerprint: Optional[str] = None

    while True:
        try:
            # Poll APIs for active data (these are free / non-Gemini hits).
            disasters = await api.get_disasters()
            sync_state_with_disasters(state, disasters)
            weather = await api.get_weather()
            traffic = await api.get_traffic()
            reports = await api.get_citizen_reports()

            # Gate the (expensive, quota-bound) Gemini call: only fire if the
            # world has actually changed since the last successful tick.
            fingerprint = _signal_fingerprint(disasters, reports, state)
            if fingerprint == last_fingerprint:
                logger.info("[Detection] No new signals; skipping Gemini call.")
                await asyncio.sleep(60)
                continue

            # Construct the context
            context = {
                "active_incidents": {k: v.model_dump() for k, v in state.active_incidents.items()},
                "signals": {
                    "disasters": disasters,
                    "weather": weather,
                    "traffic": traffic,
                    "reports": reports
                }
            }

            prompt_content = f"Analyze the following current data:\n{context}"

            logger.info("[Detection] Sending request to Gemini...")
            response = await generate_with_fallback(
                client,
                contents=prompt_content,
                config=types.GenerateContentConfig(
                    system_instruction=prompt,
                    tools=gemini_tools,
                    temperature=0.2,
                ),
                label="Detection",
            )
            logger.info("[Detection] Received response from Gemini.")
            last_fingerprint = fingerprint

            # Extract tool calls and execute
            if response.function_calls:
                for function_call in response.function_calls:
                    logger.info(f"[Detection] Executing tool: {function_call.name}")
                    
                    # ToolExecutor handles the actual logic and updates state.py implicitly
                    result = await tool_executor.execute(
                        tool_name=function_call.name,
                        arguments=function_call.args
                    )
                    
                    # Update audit
                    audit.log_tool_call(
                        agent_id=state.agent_id,
                        tool_name=function_call.name,
                        arguments=function_call.args,
                        result=result
                    )
            elif response.text:
                audit.log_observation(
                    agent_id=state.agent_id,
                    source="detection_loop",
                    data=response.text
                )
                
        except Exception as e:
            logger.error(f"Error in detection_loop: {e}", exc_info=True)
            audit.log_recovery_action(state.agent_id, f"detection_loop error: {e}", "Wait and retry")
            if isinstance(e, genai_errors.ClientError) and getattr(e, "code", None) == 429:
                delay = _extract_retry_delay_seconds(e) or 30.0
                logger.warning(f"[Detection] Gemini 429 — sleeping {delay:.0f}s before retry")
                await asyncio.sleep(delay)
                continue

        # Sleep to avoid spamming the APIs / staying inside free-tier quota.
        await asyncio.sleep(60)


async def monitoring_supervisor(api: SentinelAPIClient, state: AgentState, audit: AuditLogger, client: genai.Client):
    """
    Loop B (Monitoring Supervisor):
    Focuses on active incidents, tracks trajectories, and manages escalations/de-escalations.
    """
    logger.info("Starting monitoring_supervisor (Loop B)")
    prompt = await load_prompt("monitoring_prompt.md")
    
    # Initialize ToolExecutor for this loop
    tool_executor = ToolExecutor(api_client=api, audit_logger=audit, gemini_client=client)
    gemini_tools = get_gemini_tools()
    last_fingerprint: Optional[str] = None

    while True:
        try:
            # Fetch active disasters from database and sync state
            disasters = await api.get_disasters()
            sync_state_with_disasters(state, disasters)

            # Only heavily monitor if there are active incidents
            if not state.active_incidents:
                last_fingerprint = None  # reset so a fresh incident triggers a call
                await asyncio.sleep(60)
                continue

            # Same gate as Detection: only call Gemini when incident state changed.
            fingerprint = _signal_fingerprint(disasters, [], state)
            if fingerprint == last_fingerprint:
                logger.info("[Monitoring] Active incidents unchanged; skipping Gemini call.")
                await asyncio.sleep(60)
                continue

            # Fetch context relevant to managing ongoing incidents
            context = {
                "active_incidents": {k: v.model_dump() for k, v in state.active_incidents.items()},
                "fire_stations": await api.get_fire_stations(),
                "police_stations": await api.get_police_stations(),
                "hospitals": await api.get_hospitals(),
                "cordons": await api.get_cordons(),
                "traffic": await api.get_traffic()
            }

            prompt_content = f"Review the active incidents and current resources:\n{context}"

            logger.info("[Monitoring] Sending request to Gemini...")
            response = await generate_with_fallback(
                client,
                contents=prompt_content,
                config=types.GenerateContentConfig(
                    system_instruction=prompt,
                    tools=gemini_tools,
                    temperature=0.2,
                ),
                label="Monitoring",
            )
            logger.info("[Monitoring] Received response from Gemini.")
            last_fingerprint = fingerprint

            if response.function_calls:
                for function_call in response.function_calls:
                    logger.info(f"[Monitoring] Executing tool: {function_call.name}")
                    result = await tool_executor.execute(
                        tool_name=function_call.name,
                        arguments=function_call.args
                    )
                    
                    audit.log_tool_call(
                        agent_id=state.agent_id,
                        tool_name=function_call.name,
                        arguments=function_call.args,
                        result=result
                    )
            elif response.text:
                audit.log_decision(
                    agent_id=state.agent_id,
                    context="monitoring_supervisor",
                    decision="Review active incidents",
                    rationale=response.text
                )
                
        except Exception as e:
            logger.error(f"Error in monitoring_supervisor: {e}", exc_info=True)
            audit.log_recovery_action(state.agent_id, f"monitoring_supervisor error: {e}", "Wait and retry")
            if isinstance(e, genai_errors.ClientError) and getattr(e, "code", None) == 429:
                delay = _extract_retry_delay_seconds(e) or 30.0
                logger.warning(f"[Monitoring] Gemini 429 — sleeping {delay:.0f}s before retry")
                await asyncio.sleep(delay)
                continue

        # Slower poll rate for monitoring loop to avoid overlaps and API spam.
        await asyncio.sleep(60)


async def main():
    """Main entrypoint for the Sentinel-Core Orchestrator."""
    logger.info("Initializing Sentinel-City AI Orchestrator")
    
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY environment variable is not set!")
        # For development without the key, you might choose to return or proceed with dummy client.
        # return
        
    # Initialize the Gemini SDK client
    client = genai.Client(api_key=api_key)
    
    # Initialize SentinelCityAPI (SentinelAPIClient) and state
    api = SentinelAPIClient()
    state = AgentState(agent_id="agent-sentinel-core")
    audit = AuditLogger()
    
    try:
        # Update AGENT_REGISTRY on startup
        logger.info("Registering agent as online...")
        await api.update_agent('agent-sentinel-core', {'status': 'online'})
        
        # Start both loops concurrently
        logger.info("Starting background loops...")
        loop_a = asyncio.create_task(detection_loop(api, state, audit, client))
        loop_b = asyncio.create_task(monitoring_supervisor(api, state, audit, client))
        
        await asyncio.gather(loop_a, loop_b)
        
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
