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

import logging
from typing import Any, Dict, List, Optional

from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, ConfigDict, Field

from tools import (
    ToolExecutor,
    _build_cordon_payload,
    _build_disaster_payload,
    _build_disaster_update_payload,
    _circle_to_geojson_polygon,
)

logger = logging.getLogger(__name__)


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
    # Circular area the alert applies to. Citizens whose last-known location
    # falls inside this circle will receive the alert via /api/me/notifications.
    target_area: Optional[_LatLngRadius] = None
    # Optional: deliver only to these specific mobile user ids (e.g. when
    # responding to a 911 caller). When set, target_area is used purely for
    # rendering the affected zone on the recipient's map — geometry-based
    # broadcast scoping is skipped.
    target_user_ids: Optional[List[str]] = None


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
    # Optional mobile worker id (the composite "device_id:sub_role" produced
    # at login) that should receive this dispatch order on their phone. Omit
    # to let the backend pick an available worker of the matching sub_role.
    assigned_worker_id: Optional[str] = None


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


# ─────────────────────────── Factory ────────────────────────────────────


def build_tools(api: Any, audit_logger: Any, gemini_client: Any, agent_id: str) -> List[BaseTool]:
    """Build the 16-tool list bound to a specific agent instance.

    Each tool emits a TOOL_CALL audit entry on success or failure so the
    ``/api/logs`` panel keeps populating with the same shape as before the
    LangGraph migration.

    Note on ``_resolve_target_via_gemini``: it's an instance method on
    ``ToolExecutor`` that uses the raw ``genai.Client`` to ask Gemini for
    real coordinates when the LLM hands us ``target={lat:0, lng:0}``. We
    instantiate a single ``ToolExecutor`` here just for that helper plus
    ``_target_is_invalid`` — we never call its ``execute()``.
    """
    legacy = ToolExecutor(api_client=api, audit_logger=audit_logger, gemini_client=gemini_client)

    async def _audit_ok(name: str, arguments: Dict[str, Any], result: Any) -> None:
        try:
            audit_logger.log_tool_call(
                agent_id=agent_id, tool_name=name, arguments=arguments, result=result
            )
        except TypeError:
            audit_logger.log_tool_call(agent_id, name, arguments, result)

    async def _audit_err(name: str, arguments: Dict[str, Any], err: Exception) -> None:
        try:
            audit_logger.log_tool_call(
                agent_id=agent_id, tool_name=name, arguments=arguments, error=str(err)
            )
        except TypeError:
            audit_logger.log_tool_call(agent_id, name, arguments, error=str(err))

    def _wrap(name: str, args_schema, fn):
        """Wrap an async dispatch fn with audit-logging + uniform error handling.

        We return a closure-bound coroutine and feed it to the @tool decorator
        so LangChain sees an async BaseTool. The wrapper turns exceptions into
        an "ERROR: ..." string the LLM can read, instead of crashing the graph
        — matching how Gemini's function-calling tolerates partial failures.
        """
        description = _DESCRIPTIONS[name]

        @tool(name, args_schema=args_schema, description=description)
        async def _runner(**kwargs):
            logger.info(f"[agent_tool:{name}] args={kwargs}")
            try:
                result = await fn(kwargs)
                await _audit_ok(name, kwargs, result)
                return result
            except Exception as e:
                logger.error(f"[agent_tool:{name}] failed: {e}", exc_info=True)
                await _audit_err(name, kwargs, e)
                return f"ERROR: {type(e).__name__}: {e}"

        return _runner

    # ─── Read tools ──────────────────────────────────────────────────

    async def _get_weather(_: Dict[str, Any]) -> Any:
        return await api.get_weather()

    async def _get_traffic(_: Dict[str, Any]) -> Any:
        return await api.get_traffic()

    async def _get_citizen_reports(_: Dict[str, Any]) -> Any:
        return await api.get_citizen_reports()

    async def _get_world_state(_: Dict[str, Any]) -> Any:
        return {
            "disasters": await api.get_disasters(),
            "fire_stations": await api.get_fire_stations(),
            "hospitals": await api.get_hospitals(),
            "police_stations": await api.get_police_stations(),
        }

    async def _get_active_notifications(_: Dict[str, Any]) -> Any:
        return await api.get_notifications()

    async def _get_active_cordons(_: Dict[str, Any]) -> Any:
        return await api.get_cordons()

    # ─── Incident mutations ──────────────────────────────────────────

    async def _declare_incident(args: Dict[str, Any]) -> Any:
        # Pydantic gives us a nested model for `location`; flatten for the
        # legacy payload-builder which expects a dict.
        loc = args.get("location")
        if hasattr(loc, "model_dump"):
            args = {**args, "location": loc.model_dump()}
        payload = _build_disaster_payload(args)
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
        # The agent calls this with {incident_id, message, severity,
        # target_area?, target_user_ids?}. Translate into the backend's
        # NotificationPayload {geometry, reason, event_id, target_user_ids,
        # route} so the mobile clients can render it without doing any
        # filtering themselves — the backend's /api/me/notifications takes
        # care of scoping per user.
        ta = args.get("target_area")
        if hasattr(ta, "model_dump"):
            ta = ta.model_dump()
        geometry: Optional[Dict[str, Any]] = None
        if ta and "lat" in ta and "lng" in ta:
            radius = float(ta.get("radius") or 500.0)
            geometry = _circle_to_geojson_polygon(
                float(ta["lat"]), float(ta["lng"]), radius
            )
        targets = args.get("target_user_ids") or None
        payload: Dict[str, Any] = {
            "geometry": geometry,
            "reason": args.get("message") or "",
            "event_id": args.get("incident_id"),
        }
        if targets:
            payload["target_user_ids"] = list(targets)
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
        """Normalize Pydantic _LatLng → dict, then re-prompt Gemini if (0,0).

        Mirrors the (0,0) recovery in tools.py:547 / tools.py:571.
        """
        if hasattr(target, "model_dump"):
            target = target.model_dump()
        if ToolExecutor._target_is_invalid(target):
            logger.warning(
                f"target {target} for incident {incident_id} is invalid; "
                "re-prompting Gemini for real coordinates"
            )
            corrected = await legacy._resolve_target_via_gemini(incident_id)
            if corrected:
                target = corrected
        return target

    async def _dispatch_units(args: Dict[str, Any]) -> Any:
        target = await _coerce_target(args["target"], args.get("incident_id"))
        payload = {
            "kind": args["unit_type"],
            "units": args["count"],
            "target": target,
            "station_id": args["station_id"],
            "incident_id": args.get("incident_id"),
        }
        if args.get("assigned_worker_id"):
            payload["assigned_worker_id"] = args["assigned_worker_id"]
        return await api.dispatch(payload)

    async def _multi_station_dispatch(args: Dict[str, Any]) -> Any:
        incident_id = args["incident_id"]
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
            res = await api.dispatch({
                "kind": d["unit_type"],
                "units": d["count"],
                "target": target,
                "station_id": d["station_id"],
                "incident_id": incident_id,
            })
            results.append(res)
        return results

    async def _return_units(args: Dict[str, Any]) -> Any:
        incident_id = args["incident_id"]
        if hasattr(api, "return_ack"):
            return await api.return_ack(incident_id, args)
        return await api._request("POST", f"/dispatch/{incident_id}/return", json=args)

    return [
        _wrap("get_weather", _NoArgs, _get_weather),
        _wrap("get_traffic", _NoArgs, _get_traffic),
        _wrap("get_citizen_reports", _NoArgs, _get_citizen_reports),
        _wrap("get_world_state", _NoArgs, _get_world_state),
        _wrap("get_active_notifications", _NoArgs, _get_active_notifications),
        _wrap("get_active_cordons", _NoArgs, _get_active_cordons),
        _wrap("declare_incident", DeclareIncidentArgs, _declare_incident),
        _wrap("update_incident", UpdateIncidentArgs, _update_incident),
        _wrap("clear_incident", IncidentIdOnly, _clear_incident),
        _wrap("publish_citizen_alert", PublishCitizenAlertArgs, _publish_citizen_alert),
        _wrap("retract_citizen_alert", RetractCitizenAlertArgs, _retract_citizen_alert),
        _wrap("create_cordon", CreateCordonArgs, _create_cordon),
        _wrap("clear_cordon", ClearCordonArgs, _clear_cordon),
        _wrap("dispatch_units", DispatchUnitsArgs, _dispatch_units),
        _wrap("multi_station_dispatch", MultiStationDispatchArgs, _multi_station_dispatch),
        _wrap("return_units", ReturnUnitsArgs, _return_units),
    ]


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
    "publish_citizen_alert": (
        "Publish a public alert to citizens about an incident. Provide a "
        "target_area {lat, lng, radius_m} circle — every citizen whose phone "
        "is inside this circle receives the alert on their mobile app. "
        "Optionally provide target_user_ids to deliver to specific recipients "
        "(e.g. a 911 caller). The backend handles all per-user delivery — "
        "do not try to enumerate citizens yourself."
    ),
    "retract_citizen_alert": "Retract an existing citizen alert.",
    "create_cordon": "Create a circular cordon (exclusion zone) around an incident location.",
    "clear_cordon": "Clear an existing cordon.",
    "dispatch_units": (
        "Dispatch emergency units (firefighter, ambulance, or police) to an "
        "incident from a single station. The target must be the incident's "
        "real coordinates, never {lat:0, lng:0}. The backend assigns the "
        "order to an available mobile worker of the matching sub-role and "
        "attaches an avoidance-aware route automatically — you do not need to "
        "specify routes or which specific worker should respond."
    ),
    "multi_station_dispatch": (
        "Dispatch units from multiple stations simultaneously to one incident. "
        "Use when one station does not have enough capacity."
    ),
    "return_units": "Return previously-dispatched units to their station once they are no longer needed.",
}
