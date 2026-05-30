"""AI-driven fire-truck dispatch planner.

Replaces the hardcoded ``FIRE_UNITS_BY_SEVERITY`` lookup in decide.py.
Gemini sees:
  - The incident (type, severity, casualties flag, n_reports, AI rationale)
  - Every nearby station with its real per-station capacity and current
    dispatch load

…and produces a per-station dispatch plan via structured-output Pydantic.

The prompt provides doctrine (judgment guidance, not a rigid table) so the
model can deviate when context warrants — e.g. a sev-medium with explicit
casualties is a stronger response than a sev-medium with no casualties,
even though a pure severity-table couldn't see that distinction.

Hard safety rails the AI cannot bypass (enforced AFTER the model returns):
  1. Each station's unit_count is clamped to that station's real available
     capacity. If the AI requests 6 from a station with 3 available, it
     gets 3.
  2. station_ids not in the offered list are dropped (no hallucinated
     stations).
  3. Total unit count is capped at 10 across all stations (sanity bound).
  4. On any Vertex error / timeout / parse failure the function returns
     ``([], "<reason>")`` — i.e. dispatch nothing, surface the failure in
     the audit log. Pipeline NEVER crashes from a dispatch-agent error.

The deterministic row-locked validation in
``pipeline.execute._execute_dispatch_locked`` runs AFTER us as a second
safety net: even if a station's availability changes between our query
and the commit, the DB transaction won't over-dispatch.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import List, Optional, Tuple

from pydantic import BaseModel, Field

from metrics import inc, observe
from pipeline.decide import DispatchOrder
from pipeline.world_slice import IncidentRef, StationRef

logger = logging.getLogger(__name__)


_DISPATCH_TIMEOUT_S = float(os.environ.get("SENTINEL_DISPATCH_TIMEOUT", "60.0"))
_DISPATCH_MODEL = os.environ.get("SENTINEL_DISPATCH_MODEL", "gemini-2.5-flash-lite")

# Absolute ceiling across the entire dispatch plan. Stops a hallucinating
# model from emptying the whole fleet at a paper-cut.
_TOTAL_UNIT_CAP = 10

# Per-disaster-type fire-eligibility map. Building_fire / wildfire / flood
# all consume fire trucks (water rescue uses the same engines). Medical
# and "other" do not — return [] without bothering Gemini.
_FIRE_DISPATCH_TYPES = {"building_fire", "wildfire", "flood"}

# Lazy: built on first use so tests/imports don't need creds.
_DISPATCH_INSTANCE = None


def _build_dispatch_model():
    global _DISPATCH_INSTANCE
    if _DISPATCH_INSTANCE is not None:
        return _DISPATCH_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
    except ImportError as exc:
        raise RuntimeError(
            "langchain_google_vertexai not installed; pipeline.dispatch_agent requires Vertex AI."
        ) from exc

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT env var must be set for pipeline.dispatch_agent")

    base = ChatVertexAI(
        model=_DISPATCH_MODEL,
        temperature=0.0,
        project=project,
        location=location,
        max_retries=1,
    )
    _DISPATCH_INSTANCE = base.with_structured_output(DispatchPlan)
    return _DISPATCH_INSTANCE


# ── Output schema ───────────────────────────────────────────────────────


class StationDispatch(BaseModel):
    """One station's contribution to the dispatch plan."""

    station_id: str = Field(
        ...,
        description=(
            "The station's id, copied verbatim from the station list in the "
            "human message. Do not invent or rename ids."
        ),
    )
    unit_count: int = Field(
        ...,
        ge=1,
        le=10,
        description=(
            "Number of fire trucks to send from THIS station. Must be at "
            "least 1 (omit the station entirely if you don't want any). "
            "Must NOT exceed the station's available count."
        ),
    )
    reason: str = Field(
        ...,
        description=(
            "One short sentence: why this many trucks from this station. "
            "Goes into the operator audit log."
        ),
    )


class DispatchPlan(BaseModel):
    """Per-station fire-truck dispatch plan for one incident."""

    dispatches: List[StationDispatch] = Field(
        default_factory=list,
        description=(
            "List of stations to dispatch from. Empty list = do not dispatch "
            "anything. Use this when the incident is genuinely minor or no "
            "station has capacity."
        ),
    )
    overall_rationale: str = Field(
        ...,
        description=(
            "One paragraph: explain the total unit count and station "
            "selection. The operator reads this in the AI Reasoning panel."
        ),
    )


_SYSTEM_PROMPT = """You are the Sentinel-City fire-dispatch planner.

You are ONLY ever invoked for incident types this department's fire engines
respond to. Your caller has already filtered for fire-eligible incidents
BEFORE invoking you. The set is exhaustive:

    building_fire  → fire engines + ladder trucks
    wildfire       → fire engines deployed as a wildland strike team
    flood          → fire engines deployed as water-rescue units (in this
                     department, the same engines double as swift-water
                     rescue; there are no separate "fire boats")

You MUST dispatch trucks for all three. Do NOT respond to a flood with
an empty dispatch list on the grounds that "it's not a fire" — in this
department, floods are a fire-engine task. The same goes for wildfires.

Your ONLY job: decide HOW MANY trucks to send from WHICH stations.

DOCTRINE — apply judgment, not a rigid table.

  Severity scale
    - low      : a contained, single-source fire with no spread and no
                 reported injuries. Smoke smell, small kitchen fire, etc.
                 Send 1 truck unless there's a reason to send more.
    - medium   : a single-building fire with visible flames, no
                 casualties, no rapid spread. Send 2-3 trucks typically.
    - high     : multi-floor / multi-building / fast-spreading,
                 possible casualties, ambiguous structural condition.
                 Send 4-6 trucks typically.
    - critical : explicit casualties, structural collapse, explosion,
                 mass-evacuation language. Send your maximum reasonable
                 response — usually 6-8 trucks.

  Modifiers that raise the response
    - Explicit casualties (trapped people, injuries, fatalities) → push
      one bucket higher than severity alone suggests.
    - Many corroborating reports (n_reports ≥ 5) → confidence is high,
      lean toward the upper end of the bucket.
    - Operator notes or AI rationale mentioning explosion / collapse /
      mass evacuation → critical-tier response regardless of severity
      string.

  Modifiers that lower the response
    - Very few reports (n_reports = 1-2) + no casualties + medium-or-
      lower severity → stay at the low end. The incident may resolve
      itself before responders arrive.

  Station selection
    - Prefer the nearest station first to minimize ETA.
    - Spill into a second or third station only when the lead can't
      cover what you need (its `available` is < what you want).
    - Don't pull from a station whose `available` is 0.
    - Don't pull from a station that's already dispatched aggressively
      (`trucks_dispatched` close to `truck_count`) unless the incident
      is critical and you have no choice.

HARD CONSTRAINTS

  - NEVER request more units from a station than its `available` count.
  - Total units across all stations should not exceed 10.
  - NEVER return an empty dispatches list because of the disaster_type.
    The disaster_type has already been gated upstream; if the request
    reached you, the type is fire-eligible. The only valid reasons for
    an empty list are (a) zero stations available or (b) the situation
    is so trivial (e.g. severity=low with 1 report and no casualties)
    that even 1 truck would be overkill. Use this sparingly.

Be decisive. The operator needs an answer; second-guessing wastes
seconds while a building burns.
"""


# ── Public entry point ──────────────────────────────────────────────────


async def decide_dispatch(
    incident: IncidentRef,
    stations: List[StationRef],
    *,
    casualties_mentioned: bool,
    n_reports: int,
    derived_confidence: float,
    severity_str: str,
    triage_rationale: Optional[str] = None,
) -> Tuple[List[DispatchOrder], str]:
    """Ask Gemini how many trucks to dispatch from which stations.

    Returns ``(orders, rationale)``. On any error: ``([], reason)``.
    """
    if incident.disaster_type not in _FIRE_DISPATCH_TYPES:
        return [], (
            f"dispatch skipped: {incident.disaster_type!r} is not a fire-eligible "
            f"incident type"
        )
    if not stations:
        return [], "dispatch skipped: no stations in range of this incident"
    if all(s.available <= 0 for s in stations):
        return [], "dispatch skipped: every nearby station is at capacity"

    inc("dispatch_agent.calls_total")
    started = time.time()
    try:
        plan = await _call_model(
            incident,
            stations,
            casualties_mentioned=casualties_mentioned,
            n_reports=n_reports,
            derived_confidence=derived_confidence,
            severity_str=severity_str,
            triage_rationale=triage_rationale,
        )
    except asyncio.TimeoutError:
        observe("dispatch_agent.latency_seconds", time.time() - started)
        inc("dispatch_agent.timeout")
        logger.warning(f"dispatch_agent: timeout after {_DISPATCH_TIMEOUT_S:.1f}s")
        return [], f"dispatch failed: agent timed out after {_DISPATCH_TIMEOUT_S:.1f}s"
    except Exception as exc:
        observe("dispatch_agent.latency_seconds", time.time() - started)
        inc(f"dispatch_agent.error.{type(exc).__name__}")
        logger.warning(f"dispatch_agent: {type(exc).__name__}: {exc}")
        return [], f"dispatch failed: {type(exc).__name__}: {exc}"

    observe("dispatch_agent.latency_seconds", time.time() - started)
    inc("dispatch_agent.success")

    orders = _validate_and_convert(plan, stations)
    return orders, plan.overall_rationale


# ── Internals ───────────────────────────────────────────────────────────


async def _call_model(
    incident: IncidentRef,
    stations: List[StationRef],
    *,
    casualties_mentioned: bool,
    n_reports: int,
    derived_confidence: float,
    severity_str: str,
    triage_rationale: Optional[str],
) -> DispatchPlan:
    from langchain_core.messages import HumanMessage, SystemMessage

    model = _build_dispatch_model()

    station_lines = []
    for s in stations:
        station_lines.append(
            f"  - station_id={s.id!r}  name={s.name!r}  distance={s.dist_m:.0f}m  "
            f"truck_count={s.truck_count}  trucks_dispatched={s.trucks_dispatched}  "
            f"available={s.available}"
        )
    stations_block = "\n".join(station_lines) if station_lines else "  (none)"

    human = (
        f"Incident profile\n"
        f"  incident_id          = {incident.id}\n"
        f"  disaster_type        = {incident.disaster_type}\n"
        f"  severity_int (1-10)  = {incident.severity}\n"
        f"  severity_bucket      = {severity_str}\n"
        f"  casualties_mentioned = {casualties_mentioned}\n"
        f"  n_reports_clustered  = {n_reports}\n"
        f"  cluster_confidence   = {derived_confidence:.2f}\n"
        f"  centroid             = ({incident.lat:.5f}, {incident.lng:.5f})\n"
    )
    if incident.notes:
        human += f"  notes                = {incident.notes!r}\n"
    if triage_rationale:
        human += f"  visual_triage_note   = {triage_rationale!r}\n"
    human += f"\nAvailable stations (closest first):\n{stations_block}\n"
    human += (
        "\nReturn a DispatchPlan: per-station unit counts (>=1 each) plus an "
        "overall rationale. Empty dispatches list means no response."
    )

    msgs = [SystemMessage(content=_SYSTEM_PROMPT), HumanMessage(content=human)]
    return await asyncio.wait_for(model.ainvoke(msgs), timeout=_DISPATCH_TIMEOUT_S)


def _validate_and_convert(
    plan: DispatchPlan, stations: List[StationRef]
) -> List[DispatchOrder]:
    """Apply the hard safety rails, then convert to DispatchOrder dataclasses."""
    by_id = {s.id: s for s in stations}
    orders: List[DispatchOrder] = []
    total = 0
    for d in plan.dispatches:
        station = by_id.get(d.station_id)
        if station is None:
            logger.info(f"dispatch_agent: dropping hallucinated station_id={d.station_id!r}")
            continue
        clamped = min(d.unit_count, station.available)
        if clamped <= 0:
            logger.info(
                f"dispatch_agent: dropping {station.id} — requested {d.unit_count}, "
                f"available {station.available}"
            )
            continue
        # Apply the global cap.
        if total + clamped > _TOTAL_UNIT_CAP:
            clamped = _TOTAL_UNIT_CAP - total
        if clamped <= 0:
            break
        orders.append(DispatchOrder(
            station_id=station.id,
            station_name=station.name,
            unit_type="firefighter",
            count=clamped,
        ))
        total += clamped
    return orders
