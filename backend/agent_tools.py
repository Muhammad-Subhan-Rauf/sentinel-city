"""
LangChain @tool ports of the 16 Sentinel-City tools.

Each tool wraps the same logic as ``tools.ToolExecutor._dispatch_tool`` but as
an async LangChain ``BaseTool`` so a LangGraph ReAct agent can call them
directly. Argument schemas mirror the Gemini function declarations in
``tools.py`` (ALL_TOOLS) so existing prompts behave identically.

The factory ``build_tools`` closes over the shared ``SentinelAPIClient``,
the raw ``genai.Client`` (still needed for the target=(0,0) re-prompt
fallback in dispatch_units / multi_station_dispatch), the ``AuditLogger``,
and an ``agent_id`` so per-tool-call audit entries identify which loop made
the call.

Payload translation helpers are re-used from ``tools.py`` — do not duplicate.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, ConfigDict, Field

from tools import (
    ToolExecutor,
    _build_cordon_payload,
    _build_disaster_payload,
    _build_disaster_update_payload,
    _build_notification_payload,
)

from metrics import inc as _metric_inc
from routing.coord_fallback import resolve_target_deterministic
from routing.triangulation import triangulate as _triangulate
from safety import policy as _policy
from safety import output_linter as _linter
from safety import verifier as _verifier
from safety import rollback as _rollback
from safety import sla as _sla

logger = logging.getLogger(__name__)


# ── Tool-result TTL cache (Ring 1, plan §1.1c) ──────────────────────────
# Tiny in-process cache to remove redundant API roundtrips inside a single
# agent turn — LangGraph ReAct often re-fetches the same read in successive
# tool steps. 30-second TTL is enough to coalesce within a turn but short
# enough that stale weather/traffic data doesn't survive across loop ticks.
_READ_CACHE_TTL_SECONDS = 30.0
_READ_CACHE: Dict[str, tuple[float, Any]] = {}


def _read_cache_get(key: str) -> Any:
    entry = _READ_CACHE.get(key)
    if not entry:
        return None
    expiry, value = entry
    if expiry < time.time():
        _READ_CACHE.pop(key, None)
        return None
    return value


def _read_cache_put(key: str, value: Any) -> None:
    _READ_CACHE[key] = (time.time() + _READ_CACHE_TTL_SECONDS, value)


async def _cached_read(name: str, fn: Callable[[], Any]) -> Any:
    """Call `fn` (no-arg async API getter) with 30s TTL cache by name."""
    cached = _read_cache_get(name)
    if cached is not None:
        _metric_inc(f"cache.read.hit.{name}")
        _metric_inc("cache.read.hit_total")
        return cached
    _metric_inc(f"cache.read.miss.{name}")
    _metric_inc("cache.read.miss_total")
    value = await fn()
    _read_cache_put(name, value)
    return value


def _to_jsonable(obj: Any) -> Any:
    """Recursively convert Pydantic models / lists / dicts into JSON-safe types.

    LangChain materializes nested args (e.g. ``target: _LatLng``) as Pydantic
    BaseModel instances, which ``json.dumps`` cannot serialize. This is the
    line of defense before anything reaches the audit logger or the
    in-memory ring buffer that ``/api/logs`` serves.
    """
    if isinstance(obj, BaseModel):
        return obj.model_dump()
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_jsonable(v) for v in obj]
    return obj


# ─────────────────────────── Argument schemas ────────────────────────────


class _AllowExtra(BaseModel):
    """Base for arg schemas. Allow extra fields so Gemini's occasional
    superset of arguments (e.g. update_incident with both 'description' and
    'notes') doesn't fail Pydantic validation before our translator runs."""

    model_config = ConfigDict(extra="allow")


class _NoArgs(_AllowExtra):
    pass


class _LatLng(_AllowExtra):
    lat: float
    lng: float


class _LatLngRadius(_AllowExtra):
    lat: float
    lng: float
    radius: Optional[float] = None


class DeclareIncidentArgs(_AllowExtra):
    type: str = Field(..., description="Incident type (fire, medical, police, flood, ...)")
    location: _LatLng = Field(..., description="Incident location {lat, lng}")
    severity: str = Field(..., description="low | medium | high | critical")
    description: str


class UpdateIncidentArgs(_AllowExtra):
    incident_id: str
    status: Optional[str] = None
    severity: Optional[str] = None
    description: Optional[str] = None


class IncidentIdOnly(_AllowExtra):
    incident_id: str


class PublishCitizenAlertArgs(_AllowExtra):
    incident_id: str
    message: str
    severity: str
    target_area: Optional[_LatLngRadius] = None


class RetractCitizenAlertArgs(_AllowExtra):
    alert_id: str


class CreateCordonArgs(_AllowExtra):
    incident_id: str
    center: _LatLng
    radius: int = Field(..., description="Cordon radius in meters")
    reason: str


class ClearCordonArgs(_AllowExtra):
    cordon_id: str


class DispatchUnitsArgs(_AllowExtra):
    incident_id: str
    station_id: str
    unit_type: str = Field(..., description="firefighter, ambulance, or police")
    count: int
    target: _LatLng = Field(..., description="Dispatch target {lat, lng}")


class _DispatchItem(_AllowExtra):
    station_id: str
    unit_type: str
    count: int


class MultiStationDispatchArgs(_AllowExtra):
    incident_id: str
    target: _LatLng
    dispatches: List[_DispatchItem]


class ReturnUnitsArgs(_AllowExtra):
    incident_id: str
    station_id: str
    unit_type: str
    count: int


class _Bbox(_AllowExtra):
    min_lat: float
    max_lat: float
    min_lng: float
    max_lng: float


class TriangulateIncidentArgs(_AllowExtra):
    """Exactly one of incident_id or search_bbox should be set."""
    incident_id: Optional[str] = Field(
        default=None, description="Refine the estimate for a known incident."
    )
    search_bbox: Optional[_Bbox] = Field(
        default=None, description="Find emerging incidents within this bbox (Detection)."
    )


# ─────────────────────────── Factory ────────────────────────────────────


def build_tools(
    api: Any,
    audit_logger: Any,
    gemini_client: Any,
    agent_id: str,
    *,
    state: Any = None,
) -> List[BaseTool]:
    """Build the 16-tool list bound to a specific agent instance.

    Each tool emits a TOOL_CALL audit entry on success or failure so the
    ``/api/logs`` panel keeps populating with the same shape as before the
    LangGraph migration.

    The wrapper now consults the safety layer (policy → linter → verifier)
    before any mutating tool fires, and schedules a RollbackChecker on
    success for high-impact actions. See ``backend/safety/`` for details.

    Args:
        state: Optional shared AgentState — used by the deterministic
            coordinate fallback to resolve (0,0) targets without a Gemini
            re-prompt. If None, falls back to the live API.

    ``gemini_client`` is kept in the signature for backward compatibility
    but is no longer used (coordinate recovery is deterministic now).
    """
    # Kept only for the static ``_target_is_invalid`` helper. No LLM use.
    legacy = ToolExecutor(api_client=api, audit_logger=audit_logger, gemini_client=None)

    async def _audit_ok(name: str, arguments: Dict[str, Any], result: Any) -> None:
        # Audit is best-effort: never let a logging failure crash a tool that
        # already succeeded against the API. The pre-serialize step removes
        # Pydantic BaseModel instances that json.dumps would choke on.
        safe_args = _to_jsonable(arguments)
        safe_result = _to_jsonable(result)
        try:
            try:
                audit_logger.log_tool_call(
                    agent_id=agent_id, tool_name=name, arguments=safe_args, result=safe_result
                )
            except TypeError:
                audit_logger.log_tool_call(agent_id, name, safe_args, safe_result)
        except Exception as audit_exc:
            logger.warning(f"[agent_tool:{name}] audit log_tool_call failed: {audit_exc}")

    async def _audit_err(name: str, arguments: Dict[str, Any], err: Exception) -> None:
        safe_args = _to_jsonable(arguments)
        try:
            try:
                audit_logger.log_tool_call(
                    agent_id=agent_id, tool_name=name, arguments=safe_args, error=str(err)
                )
            except TypeError:
                audit_logger.log_tool_call(agent_id, name, safe_args, error=str(err))
        except Exception as audit_exc:
            logger.warning(f"[agent_tool:{name}] audit log_tool_call (err) failed: {audit_exc}")

    # Raw-fn registry for the RollbackChecker callback. Maps tool name to
    # the underlying async dispatch fn (kwargs-dict in, API result out) WITHOUT
    # the safety wrapper — so auto-rollback can fire return_units / clear_cordon
    # / retract_citizen_alert without re-triggering the verifier on themselves.
    _raw_dispatch: Dict[str, Callable[[Dict[str, Any]], Any]] = {}

    async def _invoke_raw(tool_name: str, args: Dict[str, Any]) -> Any:
        fn = _raw_dispatch.get(tool_name)
        if fn is None:
            raise ValueError(f"no raw dispatch registered for {tool_name}")
        # Pydantic-shape inputs aren't required for the rollback path — the
        # legacy fns take a plain dict. Audit so the rollback shows up.
        result = await fn(args)
        await _audit_ok(tool_name, args, result)
        _metric_inc(f"tool.invoke.raw.{tool_name}")
        return result

    def _wrap(name: str, args_schema, fn):
        """Wrap an async dispatch fn with safety + audit + error handling.

        Flow for every tool call:
          1. policy.evaluate(name, args) → tier + flags
          2. If needs_lint: output_linter.lint(...) — modify or block
          3. If needs_verifier: verifier.verify(...) — approve/modify/deny
          4. fn(args)  ← actual API call
          5. On success at tier ≥ 2 with a rollback mapping:
             rollback.schedule(...) to re-verify in the future
          6. Audit-log result or error; return string error to the LLM on
             exception so the graph keeps running.
        """
        description = _DESCRIPTIONS[name]
        _raw_dispatch[name] = fn

        @tool(name, args_schema=args_schema, description=description)
        async def _runner(**kwargs):
            logger.info(f"[agent_tool:{name}] args={kwargs}")
            _metric_inc(f"tool.invoke.{name}")

            # The safety layer (policy / linter / verifier) expects plain
            # dicts. LangChain materializes args as Pydantic models when an
            # args_schema is set (e.g. dispatches becomes List[_DispatchItem]),
            # and `d.get("count")` would AttributeError. Normalize once, and
            # keep using the dict form going forward — the underlying tool
            # fns already accept plain dicts.
            try:
                kwargs = _to_jsonable(kwargs)
            except Exception as norm_exc:
                logger.warning(f"[agent_tool:{name}] arg normalization failed: {norm_exc}")
                # Best-effort: continue with raw kwargs and hope individual
                # steps handle it. The outer try/except below will catch any
                # downstream crashes.

            # Safety chain — wrapped so any exception inside policy/lint/
            # verifier becomes a tool-level error string instead of crashing
            # the LangGraph node (which used to surface as an outer-loop
            # 'detection_loop error' RECOVERY_ACTION).
            try:
                # 1. Policy
                decision = _policy.evaluate(name, kwargs)
                _metric_inc(f"policy.tier.{decision.tier}")

                # 2. Linter — runs before the verifier so the verifier sees the
                #    sanitized args, not the raw LLM output.
                lint_reasons: List[str] = []
                if decision.needs_lint:
                    lint_result = _linter.lint(name, kwargs)
                    lint_reasons = lint_result.reasons
                    if lint_result.verdict == "block":
                        _metric_inc(f"linter.block.{name}")
                        msg = f"BLOCKED by output_linter: {'; '.join(lint_reasons)}"
                        logger.warning(f"[agent_tool:{name}] {msg}")
                        await _audit_err(name, kwargs, ValueError(msg))
                        return f"ERROR: {msg}"
                    if lint_result.verdict == "modify":
                        _metric_inc(f"linter.modify.{name}")
                        logger.info(f"[agent_tool:{name}] linter modified args: {lint_reasons}")
                        kwargs = lint_result.args

                # 3. Verifier
                verdict = None
                if decision.needs_verifier:
                    rationale = _extract_rationale(kwargs)
                    verdict = await _verifier.verify(
                        tool=name,
                        args=kwargs,
                        rationale=rationale,
                        context_summary=decision.reason,
                        policy_tier=decision.tier,
                    )
                    if verdict.decision == "deny":
                        _metric_inc(f"verifier.applied_deny.{name}")
                        msg = f"DENIED by verifier: {verdict.rationale}"
                        logger.warning(f"[agent_tool:{name}] {msg}")
                        await _audit_err(name, kwargs, ValueError(msg))
                        return f"ERROR: {msg}"
                    if verdict.decision == "modify" and isinstance(verdict.modified_args, dict):
                        _metric_inc(f"verifier.applied_modify.{name}")
                        logger.info(
                            f"[agent_tool:{name}] verifier modified args: {verdict.rationale}"
                        )
                        kwargs = {**kwargs, **verdict.modified_args}
            except Exception as safety_exc:
                # A bug in the safety layer should NEVER take down the agent.
                # Log, count, and let the actual tool fn proceed with the
                # (possibly-unsanitized) args. Worst case the verifier or
                # linter is bypassed once — better than the AI grinding to a
                # halt mid-incident.
                _metric_inc(f"safety_layer.exception.{name}")
                logger.error(
                    f"[agent_tool:{name}] safety layer raised {type(safety_exc).__name__}: "
                    f"{safety_exc}. Bypassing safety for this call.",
                    exc_info=True,
                )

            # 4. Execute
            try:
                result = await fn(kwargs)
                await _audit_ok(name, kwargs, result)
            except Exception as e:
                logger.error(f"[agent_tool:{name}] failed: {e}", exc_info=True)
                await _audit_err(name, kwargs, e)
                _metric_inc(f"tool.error.{name}")
                return f"ERROR: {type(e).__name__}: {e}"

            # 5. Schedule rollback re-check for high-impact actions
            if decision.tier >= 2:
                _rollback.schedule(
                    tool=name,
                    args=_to_jsonable(kwargs),
                    result=result,
                    rationale=(verdict.rationale if verdict else decision.reason),
                    invoke_tool=_invoke_raw,
                )

            # 6. SLA tracking — feeds the dispatch-SLA watchdog
            _track_sla_event(name, kwargs, result)

            _metric_inc(f"tool.success.{name}")
            return result

        return _runner

    def _extract_rationale(args: Dict[str, Any]) -> str:
        for key in ("rationale", "reason", "description", "message"):
            v = args.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()[:200]
        return ""

    def _track_sla_event(name: str, kwargs: Dict[str, Any], result: Any) -> None:
        """Feed the dispatch-SLA watchdog. No-ops on non-relevant tools."""
        try:
            if name == "declare_incident":
                # Result usually carries the new incident's id
                new_id = None
                if isinstance(result, dict):
                    new_id = result.get("id") or result.get("event_id") or result.get("incident_id")
                if new_id:
                    _sla.track_declared(str(new_id))
            elif name in {"dispatch_units", "multi_station_dispatch"}:
                inc_id = kwargs.get("incident_id")
                if inc_id:
                    _sla.track_dispatched(str(inc_id))
                # When an ambulance is dispatched to a precise target, mark
                # any pending casualty reports within 100m as resolved so the
                # AI doesn't re-see them and re-dispatch on its next tick.
                unit_type = kwargs.get("unit_type")
                if unit_type == "ambulance":
                    target = kwargs.get("target") or {}
                    if hasattr(target, "model_dump"):
                        target = target.model_dump()
                    try:
                        lat = float((target or {}).get("lat", 0))
                        lng = float((target or {}).get("lng", 0))
                        if not (abs(lat) < 0.001 and abs(lng) < 0.001):
                            # Fire-and-forget — never crash the audit/sla hook.
                            import asyncio as _aio
                            _aio.get_event_loop().create_task(
                                api.resolve_responder_reports_near(
                                    lat=lat, lng=lng, radius_m=100.0,
                                    report_kind_prefix="casualty_",
                                )
                            )
                            _metric_inc("responder_reports.auto_resolve_scheduled")
                    except Exception as resolve_exc:
                        logger.debug(f"resolve-near schedule failed: {resolve_exc}")
        except Exception as exc:
            logger.debug(f"_track_sla_event failed for {name}: {exc}")

    # ─── Read tools (TTL-cached, plan §1.1c) ─────────────────────────

    async def _get_weather(_: Dict[str, Any]) -> Any:
        return await _cached_read("get_weather", api.get_weather)

    async def _get_traffic(_: Dict[str, Any]) -> Any:
        return await _cached_read("get_traffic", api.get_traffic)

    async def _get_citizen_reports(_: Dict[str, Any]) -> Any:
        return await _cached_read("get_citizen_reports", api.get_citizen_reports)

    async def _get_world_state(_: Dict[str, Any]) -> Any:
        # Compose from individually-cached pieces so a single agent turn
        # that calls get_world_state then get_active_cordons hits the cache.
        return {
            "disasters": await _cached_read("get_disasters", api.get_disasters),
            "fire_stations": await _cached_read("get_fire_stations", api.get_fire_stations),
            "hospitals": await _cached_read("get_hospitals", api.get_hospitals),
            "police_stations": await _cached_read("get_police_stations", api.get_police_stations),
        }

    async def _get_active_notifications(_: Dict[str, Any]) -> Any:
        return await _cached_read("get_notifications", api.get_notifications)

    async def _get_active_cordons(_: Dict[str, Any]) -> Any:
        return await _cached_read("get_cordons", api.get_cordons)

    # ─── Incident mutations ──────────────────────────────────────────

    async def _declare_incident(args: Dict[str, Any]) -> Any:
        # Pydantic gives us a nested model for `location`; flatten for the
        # legacy payload-builder which expects a dict.
        loc = args.get("location")
        if hasattr(loc, "model_dump"):
            args = {**args, "location": loc.model_dump()}
        payload = _build_disaster_payload(args)

        # Dedup: if there's already an active disaster of the same type
        # within DECLARE_DEDUP_RADIUS_M of this location, surface IT instead
        # of creating a new one. The AI's triangulation tends to land within
        # a few hundred metres of an existing event whose citizen-report
        # cluster the AI just rediscovered.
        DECLARE_DEDUP_RADIUS_M = 800.0
        try:
            new_lat = float(args["location"]["lat"])
            new_lng = float(args["location"]["lng"])
            new_type = str(payload.get("disaster_type", "")).strip().lower()
            existing = await api.get_disasters()
            existing_list = existing if isinstance(existing, list) else (existing or {}).get("disasters", [])
            from routing.coord_fallback import _coords_from_geometry as _xy
            from baseline.rule_engine import haversine as _hav
            for d in existing_list or []:
                if not isinstance(d, dict):
                    continue
                if d.get("status") != "active":
                    continue
                # Match same disaster type to avoid suppressing a legitimate
                # different incident in the same area (e.g. fire + accident).
                if str(d.get("disaster_type", "")).strip().lower() != new_type:
                    continue
                coords = _xy(d.get("area_geometry"))
                if not coords:
                    continue
                dist = _hav(new_lat, new_lng, float(coords["lat"]), float(coords["lng"]))
                if dist <= DECLARE_DEDUP_RADIUS_M:
                    logger.warning(
                        f"declare_incident DEDUP: a {new_type} incident already exists "
                        f"{dist:.0f}m away (id={d.get('id')}). Returning existing record."
                    )
                    _metric_inc("declare_incident.dedup_hit")
                    return {
                        "id": d.get("id"),
                        "deduped": True,
                        "distance_m": round(dist, 1),
                        "existing_disaster_type": d.get("disaster_type"),
                    }
        except Exception as dedup_exc:
            logger.debug(f"declare_incident dedup probe failed: {dedup_exc}")
            # Fall through to the original create — dedup is best-effort.

        _metric_inc("declare_incident.create")
        return await api.trigger_disaster(payload)

    async def _update_incident(args: Dict[str, Any]) -> Any:
        if not args.get("incident_id"):
            raise ValueError("Missing 'incident_id' in update_incident")
        payload = _build_disaster_update_payload(args)
        return await api.update_disaster(args["incident_id"], payload)

    async def _clear_incident(args: Dict[str, Any]) -> Any:
        if not args.get("incident_id"):
            raise ValueError("Missing 'incident_id' in clear_incident")
        return await api.delete_disaster(args["incident_id"])

    # ─── Citizen alerts & cordons ───────────────────────────────────

    async def _publish_citizen_alert(args: Dict[str, Any]) -> Any:
        payload = _build_notification_payload(args)
        return await api.notify(payload)

    async def _retract_citizen_alert(args: Dict[str, Any]) -> Any:
        if not args.get("alert_id"):
            raise ValueError("Missing 'alert_id' in retract_citizen_alert")
        return await api._request("DELETE", f"/notifications/{args['alert_id']}")

    async def _create_cordon(args: Dict[str, Any]) -> Any:
        center = args.get("center")
        if hasattr(center, "model_dump"):
            args = {**args, "center": center.model_dump()}
        payload = _build_cordon_payload(args)
        return await api.cordon(payload)

    async def _clear_cordon(args: Dict[str, Any]) -> Any:
        if not args.get("cordon_id"):
            raise ValueError("Missing 'cordon_id' in clear_cordon")
        return await api._request("DELETE", f"/cordons/{args['cordon_id']}")

    # ─── Dispatch ────────────────────────────────────────────────────

    async def _coerce_target(target: Any, incident_id: Optional[str]) -> Dict[str, float]:
        """Normalize Pydantic _LatLng → dict, then DETERMINISTICALLY recover
        if (0,0). No more Gemini re-prompt — we already know the incident's
        location from in-memory state or its area_geometry on the API.
        Plan §1.2: "Deterministic fallback: incident area_geometry centroid".
        """
        if hasattr(target, "model_dump"):
            target = target.model_dump()
        if ToolExecutor._target_is_invalid(target):
            _metric_inc("coord_fallback.triggered")
            logger.warning(
                f"target {target} for incident {incident_id} is invalid; "
                "resolving deterministically"
            )
            corrected = await resolve_target_deterministic(incident_id, api, state)
            if corrected:
                _metric_inc("coord_fallback.resolved")
                target = corrected
            else:
                _metric_inc("coord_fallback.unresolved")
        return target

    # Override threshold: if the AI's station is more than this ratio further
    # than the nearest available, server substitutes the nearest. 1.3 = "if
    # the AI's choice is >30% further away than it should be". Avoids
    # nit-picking when AI picks #2 by a hair but catches the "furthest of
    # five stations" failure mode.
    _STATION_OVERRIDE_RATIO = 1.3

    _STATION_KIND_TO_RESOURCE_KIND = {
        "firefighter": "fire_station",
        "fire": "fire_station",
        "ambulance": "hospital",
        "paramedic": "hospital",
        "police": "police_station",
        "officer": "police_station",
    }

    async def _maybe_override_station(
        unit_type: str, station_id: str, target: Dict[str, float], count: int,
    ) -> str:
        """If the AI picked a station that's far worse than the nearest with
        capacity, substitute the nearest. Returns the station_id to actually use.
        Best-effort: any error returns the AI's original choice.
        """
        resource_kind = _STATION_KIND_TO_RESOURCE_KIND.get(str(unit_type).lower())
        if not resource_kind or not station_id:
            return station_id
        try:
            lat = float((target or {}).get("lat"))
            lng = float((target or {}).get("lng"))
        except (TypeError, ValueError, AttributeError):
            return station_id
        if abs(lat) < 0.001 and abs(lng) < 0.001:
            return station_id
        try:
            payload = await api.get_nearest_resources(lat, lng, kind=resource_kind, limit=5)
            ranked = (payload or {}).get("resources", []) or []
        except Exception as exc:
            logger.debug(f"override probe failed for {unit_type}: {exc}")
            return station_id
        if not ranked:
            return station_id
        # Find the nearest entry with enough available capacity for the request.
        nearest_ok = next((r for r in ranked if r.get("available", 0) >= count), None)
        if nearest_ok is None:
            # No station has the full count; the AI's choice is no worse than
            # any other, leave it alone.
            return station_id
        chosen = next((r for r in ranked if str(r.get("id")) == str(station_id)), None)
        if chosen is None:
            # AI's chosen station isn't in the top-5 nearest at all — definitely
            # override unless it'd lose capacity.
            logger.warning(
                f"station override: {unit_type} dispatch wanted {station_id} "
                f"(not in top-5 nearest); using {nearest_ok['id']} "
                f"({nearest_ok['distance_m']}m, {nearest_ok['available']} available)"
            )
            _metric_inc(f"station_override.not_in_top5.{unit_type}")
            return str(nearest_ok["id"])
        chosen_dist = float(chosen.get("distance_m", 1e9))
        nearest_dist = float(nearest_ok.get("distance_m", 0))
        if nearest_dist > 0 and chosen_dist / nearest_dist > _STATION_OVERRIDE_RATIO:
            logger.warning(
                f"station override: {unit_type} dispatch wanted {station_id} "
                f"({chosen_dist:.0f}m); using nearer {nearest_ok['id']} "
                f"({nearest_dist:.0f}m, ratio {chosen_dist/nearest_dist:.2f}x)"
            )
            _metric_inc(f"station_override.too_far.{unit_type}")
            return str(nearest_ok["id"])
        return station_id

    # Unit types that require a triangulated location_estimate before they
    # can be dispatched. Per operator rule: don't send fire trucks (or police)
    # to a location that hasn't been corroborated by citizen reports.
    # Ambulances are exempt because their target is a precise responder GPS
    # (auto-dispatched server-side from casualty reports, never AI-driven).
    _TRIANGULATION_REQUIRED_UNITS = {"firefighter", "fire", "police", "officer"}

    def _has_triangulated_estimate(incident_id: Optional[str]) -> bool:
        if not incident_id or state is None:
            return False
        inc = getattr(state, "active_incidents", {}).get(incident_id)
        if inc is None:
            return False
        est = getattr(inc, "location_estimate", None)
        if not isinstance(est, dict):
            return False
        try:
            lat = float(est.get("lat", 0))
            lng = float(est.get("lng", 0))
            return not (abs(lat) < 0.001 and abs(lng) < 0.001)
        except (TypeError, ValueError):
            return False

    async def _dispatch_units(args: Dict[str, Any]) -> Any:
        # Gate: fire trucks / police require a triangulated estimate. Citizens
        # must have corroborated the location before responders are sent.
        # If the estimate is missing, AUTO-TRIANGULATE here (no LLM) instead
        # of refusing — the AI shouldn't have to spend recursion cycles on a
        # ritual the system can perform itself.
        unit_type = str(args.get("unit_type") or "").lower()
        incident_id = args.get("incident_id")
        if unit_type in _TRIANGULATION_REQUIRED_UNITS:
            if not _has_triangulated_estimate(incident_id):
                # Try to triangulate now — pure server-side, no LLM token spend.
                try:
                    est = await _triangulate(api, incident_id=incident_id, state=state)
                except Exception as tri_exc:
                    _metric_inc(f"dispatch.auto_triangulate_error.{unit_type}")
                    return f"ERROR: REFUSED dispatch {unit_type} — auto-triangulation crashed: {tri_exc}"
                conf = float((est or {}).get("confidence", 0))
                n_reports = int((est or {}).get("n_reports", 0))
                if conf < 0.3 or n_reports < 3:
                    _metric_inc(f"dispatch.blocked_no_signal.{unit_type}")
                    return (
                        f"ERROR: REFUSED dispatch {unit_type} to incident {incident_id!r} — "
                        f"insufficient citizen signal (confidence={conf}, n_reports={n_reports}). "
                        "Wait for more reports."
                    )
                _metric_inc(f"dispatch.auto_triangulated.{unit_type}")
                # _triangulate already cached the estimate on state via
                # _cache_on_state, so the gate would now pass — proceed.
        target = await _coerce_target(args["target"], args.get("incident_id"))
        station_id = await _maybe_override_station(
            args.get("unit_type"), args.get("station_id"), target, int(args.get("count", 1)),
        )
        payload = {
            "kind": args["unit_type"],
            "units": args["count"],
            "target": target,
            "station_id": station_id,
        }
        return await api.dispatch(payload)

    async def _multi_station_dispatch(args: Dict[str, Any]) -> Any:
        incident_id = args["incident_id"]
        # Same gate as single dispatch: if any of the per-station entries is
        # for a triangulation-required unit type, refuse the whole batch
        # unless the incident has been triangulated.
        dispatches_raw = args.get("dispatches") or []
        needs_triangulation = any(
            str((d.model_dump() if hasattr(d, "model_dump") else (d or {})).get("unit_type", "")).lower()
            in _TRIANGULATION_REQUIRED_UNITS
            for d in dispatches_raw
        )
        if needs_triangulation and not _has_triangulated_estimate(incident_id):
            try:
                est = await _triangulate(api, incident_id=incident_id, state=state)
            except Exception as tri_exc:
                _metric_inc("dispatch.auto_triangulate_error.multi_station")
                return f"ERROR: REFUSED multi_station_dispatch — auto-triangulation crashed: {tri_exc}"
            conf = float((est or {}).get("confidence", 0))
            n_reports = int((est or {}).get("n_reports", 0))
            if conf < 0.3 or n_reports < 3:
                _metric_inc("dispatch.blocked_no_signal.multi_station")
                return (
                    f"ERROR: REFUSED multi_station_dispatch to {incident_id!r} — "
                    f"insufficient citizen signal (confidence={conf}, n_reports={n_reports})."
                )
            _metric_inc("dispatch.auto_triangulated.multi_station")

        target = await _coerce_target(args["target"], incident_id)
        dispatches = args["dispatches"]
        # Pydantic may give us list[_DispatchItem]; normalize to plain dicts.
        norm = []
        for d in dispatches:
            if hasattr(d, "model_dump"):
                d = d.model_dump()
            norm.append(d)
        results = []
        for d in norm:
            for field in ("station_id", "unit_type", "count"):
                if field not in d:
                    raise ValueError(f"Missing '{field}' in dispatch item")
            station_id = await _maybe_override_station(
                d["unit_type"], d["station_id"], target, int(d["count"]),
            )
            res = await api.dispatch({
                "kind": d["unit_type"],
                "units": d["count"],
                "target": target,
                "station_id": station_id,
            })
            results.append(res)
        return results

    async def _return_units(args: Dict[str, Any]) -> Any:
        incident_id = args["incident_id"]
        if hasattr(api, "return_ack"):
            return await api.return_ack(incident_id, args)
        return await api._request("POST", f"/dispatch/{incident_id}/return", json=args)

    # ─── Triangulation (signal-only localization, no ground truth) ───

    async def _triangulate_incident(args: Dict[str, Any]) -> Any:
        bbox = args.get("search_bbox")
        if hasattr(bbox, "model_dump"):
            bbox = bbox.model_dump()
        return await _triangulate(
            api,
            incident_id=args.get("incident_id"),
            search_bbox=bbox,
            state=state,
        )

    tools = [
        _wrap("get_weather", _NoArgs, _get_weather),
        _wrap("get_traffic", _NoArgs, _get_traffic),
        _wrap("get_citizen_reports", _NoArgs, _get_citizen_reports),
        _wrap("get_world_state", _NoArgs, _get_world_state),
        _wrap("get_active_notifications", _NoArgs, _get_active_notifications),
        _wrap("get_active_cordons", _NoArgs, _get_active_cordons),
        # declare_incident intentionally REMOVED from the AI's toolset.
        # Per operator decision, the AI cannot spawn new disasters — only the
        # human operator (dashboard "Trigger Disaster" → POST /api/trigger-disaster)
        # can. The AI's job is dispatching, cordoning, alerting, updating, and
        # clearing — not creating. The _declare_incident fn + dedup logic are
        # kept above as dead code in case we ever re-enable it for a subset of
        # disaster_types.
        _wrap("update_incident", UpdateIncidentArgs, _update_incident),
        _wrap("clear_incident", IncidentIdOnly, _clear_incident),
        _wrap("publish_citizen_alert", PublishCitizenAlertArgs, _publish_citizen_alert),
        _wrap("retract_citizen_alert", RetractCitizenAlertArgs, _retract_citizen_alert),
        _wrap("create_cordon", CreateCordonArgs, _create_cordon),
        _wrap("clear_cordon", ClearCordonArgs, _clear_cordon),
        _wrap("dispatch_units", DispatchUnitsArgs, _dispatch_units),
        _wrap("multi_station_dispatch", MultiStationDispatchArgs, _multi_station_dispatch),
        _wrap("return_units", ReturnUnitsArgs, _return_units),
        _wrap("triangulate_incident", TriangulateIncidentArgs, _triangulate_incident),
    ]
    return tools


def make_tool_invoker(tools: List[BaseTool]) -> Callable[[str, Dict[str, Any]], Any]:
    """Return an async (name, args_dict) -> result callable for cache replay.

    The returned closure dispatches to the BaseTool's `ainvoke` so the full
    safety pipeline still runs on replay (policy + lint + verifier + audit +
    rollback). A cache hit means we skipped the LLM, not the safety layer.
    """
    by_name = {t.name: t for t in tools}

    async def _invoke(name: str, args: Dict[str, Any]) -> Any:
        tool_obj = by_name.get(name)
        if tool_obj is None:
            return f"ERROR: unknown tool '{name}' in cache replay"
        return await tool_obj.ainvoke(args)

    return _invoke


_DESCRIPTIONS: Dict[str, str] = {
    "get_weather": "Get current weather conditions in Sentinel City.",
    "get_traffic": "Get current traffic conditions.",
    "get_citizen_reports": "Get recent citizen reports.",
    "get_world_state": "Get the full current world state (active disasters, fire stations, hospitals, police stations).",
    "get_active_notifications": "Get all active notifications and citizen alerts.",
    "get_active_cordons": "Get all active cordons in the city.",
    "declare_incident": "Declare a new incident or disaster. Use only when no matching incident already exists.",
    "update_incident": "Update an existing incident (status, severity, or notes).",
    "clear_incident": "Mark an incident as resolved and remove it.",
    "publish_citizen_alert": "Publish a public alert to citizens about an incident.",
    "retract_citizen_alert": "Retract an existing citizen alert.",
    "create_cordon": "Create a circular cordon (exclusion zone) around an incident location.",
    "clear_cordon": "Clear an existing cordon.",
    "dispatch_units": (
        "Dispatch emergency units (firefighter, ambulance, or police) to an incident "
        "from a single station. The target must be the incident's real coordinates, "
        "never {lat:0, lng:0}."
    ),
    "multi_station_dispatch": (
        "Dispatch units from multiple stations simultaneously to one incident. "
        "Use when one station does not have enough capacity."
    ),
    "return_units": "Return previously-dispatched units to their station once they are no longer needed.",
    "triangulate_incident": (
        "REQUIRED before any dispatch_units / multi_station_dispatch / create_cordon call. "
        "Clusters recent citizen reports to estimate an incident's approximate location. "
        "Pass incident_id for a known incident, or search_bbox to find emerging incidents. "
        "Returns {lat, lng, uncertainty_m, confidence, n_reports, sample_transcripts}. "
        "If confidence < 0.3, wait for more reports rather than acting on a bad estimate."
    ),
}
