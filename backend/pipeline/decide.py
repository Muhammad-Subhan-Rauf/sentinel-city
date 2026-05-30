"""Deterministic Python policy engine.

This is where every dispatch / cordon / alert decision is made. No LLM
involvement; pure functions over typed inputs.

Composition:
  - ``should_declare(cluster)``   → DeclareIncident | None
  - ``plan_cordon(incident)``     → CordonOrder | None
  - ``plan_alert(incident)``      → AlertOrder  | None
  - ``plan_response(world)``      → ResponsePlan  (async — bundles the above
                                    plus an AI-driven dispatch decision via
                                    pipeline/dispatch_agent.py)

Dispatch unit counts USED to be a hardcoded ``FIRE_UNITS_BY_SEVERITY`` map
here. They are now produced per-incident by the AI dispatch agent, which
takes the full incident profile + the live per-station capacity into
account. The cordon-radius table and alert-template map still live here
because those weren't called out for AI-isation in this iteration.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

from pipeline.cluster import (
    MIN_CLUSTER_CONFIDENCE,
    MIN_REPORTS_TO_DECLARE,
    ReportCluster,
    cluster_confidence,
)
from pipeline.world_slice import IncidentRef, StationRef, WorldSlice

logger = logging.getLogger(__name__)


SeverityStr = Literal["low", "medium", "high", "critical"]


# ── Policy tables ───────────────────────────────────────────────────────


# Severity string → int (1..10) for disaster_events.severity persistence.
# Aligns with prompts/detection_prompt.md (which had the same table buried
# in the prompt). Moved here so it's testable.
SEVERITY_TO_INT: Dict[SeverityStr, int] = {
    "low": 2,
    "medium": 4,
    "high": 6,
    "critical": 8,
}

# Reverse map: clamp an int severity into a string bucket.
def severity_int_to_str(n: int) -> SeverityStr:
    if n <= 3:
        return "low"
    if n <= 5:
        return "medium"
    if n <= 7:
        return "high"
    return "critical"


# Fire-truck dispatch counts are NO LONGER a hardcoded table here. The AI
# dispatch agent (pipeline/dispatch_agent.py) makes that call per-incident,
# given the incident profile and the live capacity of each nearby station.
# That lets it apply context (explicit casualties, n_reports, operator
# notes, visual-triage notes) instead of mechanically reading a severity →
# count map. The deterministic row-locked validation in execute.py is
# still the final gate, so a misbehaving model can't over-dispatch.

# Cordon radius (meters) by severity. Roughly: half the expected wave radius.
CORDON_RADIUS_BY_SEVERITY: Dict[SeverityStr, int] = {
    "low": 100,
    "medium": 200,
    "high": 400,
    "critical": 800,
}


# Citizen alert severity → directive verb requirement (the linter check
# from old safety/output_linter.py — same rule, deterministic now).
ALERT_SEVERITIES_REQUIRING_DIRECTIVE = {"warning", "evacuation"}
DIRECTIVE_VERBS = {"evacuate", "shelter", "avoid", "stay", "leave"}


# Re-declaration cooldown: don't re-declare an incident of the same type
# within 800m of one cleared in the last 30 minutes. Operator already
# rejected it; trust the operator. (From detection_prompt.md line 24.)
DECLARE_COOLDOWN_RADIUS_M = 800.0


# ── Output shapes ───────────────────────────────────────────────────────


@dataclass
class DeclareIncident:
    incident_type: str
    severity: SeverityStr
    severity_int: int
    centroid_lat: float
    centroid_lng: float
    n_reports: int
    derived_confidence: float        # cluster_confidence, NOT LLM self-rating
    notes: str
    seed_report_id: str
    member_report_ids: List[str]     # so execute.py can stamp declared_incident_id on them


@dataclass
class DispatchOrder:
    station_id: str
    station_name: str
    unit_type: Literal["firefighter"]
    count: int


@dataclass
class CordonOrder:
    incident_id: str
    centroid_lat: float
    centroid_lng: float
    radius_m: int
    reason: str


@dataclass
class AlertOrder:
    incident_id: str
    severity: Literal["info", "advisory", "warning", "evacuation"]
    message: str


@dataclass
class ResponsePlan:
    """Bundle of orders for one incident. Any field may be None / empty
    if the policy says no action of that kind is warranted right now."""
    incident_id: str
    dispatches: List[DispatchOrder] = field(default_factory=list)
    cordon: Optional[CordonOrder] = None
    alert: Optional[AlertOrder] = None
    rationale: str = ""


# ── should_declare ──────────────────────────────────────────────────────


def should_declare(
    cluster: ReportCluster,
    *,
    recent_cleared_incidents: Optional[List[IncidentRef]] = None,
    active_incidents_same_type: Optional[List[IncidentRef]] = None,
) -> Optional[DeclareIncident]:
    """Decide whether a fresh declare_incident is warranted.

    Returns None unless ALL of these hold:
      - cluster.n_reports ≥ MIN_REPORTS_TO_DECLARE
      - cluster_confidence(cluster) ≥ MIN_CLUSTER_CONFIDENCE
      - no active same-type incident within 800m (server-side dedup already
        does this; we check anyway so execute.py can short-circuit before
        opening a transaction)
      - no cooldown collision: same type cleared by operator in the last
        30 minutes within 800m. Trust the operator's clear.

    The decision uses cluster_confidence (Python-derived from density) NOT
    the LLM's self-rated confidence (Trap 1).
    """
    if cluster.n_reports < MIN_REPORTS_TO_DECLARE:
        return None

    conf = cluster_confidence(cluster)
    if conf < MIN_CLUSTER_CONFIDENCE:
        return None

    # Active same-type collision: server-side dedup catches it too, but
    # short-circuit cheap.
    if active_incidents_same_type:
        from pipeline.cluster import _haversine_m
        for inc in active_incidents_same_type:
            d = _haversine_m(cluster.centroid_lat, cluster.centroid_lng, inc.lat, inc.lng)
            if d <= DECLARE_COOLDOWN_RADIUS_M:
                logger.info(
                    f"should_declare: skipping — active {inc.disaster_type} "
                    f"already at {d:.0f}m"
                )
                return None

    # Operator-cleared cooldown.
    if recent_cleared_incidents:
        from pipeline.cluster import _haversine_m
        for inc in recent_cleared_incidents:
            d = _haversine_m(cluster.centroid_lat, cluster.centroid_lng, inc.lat, inc.lng)
            if d <= DECLARE_COOLDOWN_RADIUS_M:
                logger.info(
                    f"should_declare: skipping — operator cleared {inc.disaster_type} "
                    f"at {d:.0f}m within cooldown"
                )
                return None

    # Severity: take the strongest severity present in the cluster, but
    # damp single-transcript hyperbole (Trap 2b) by requiring ≥ 2 reports
    # at that level for high/critical to stick.
    severity = _consensus_severity(cluster)
    severity_int = SEVERITY_TO_INT[severity]

    return DeclareIncident(
        incident_type=cluster.incident_type,
        severity=severity,
        severity_int=severity_int,
        centroid_lat=cluster.centroid_lat,
        centroid_lng=cluster.centroid_lng,
        n_reports=cluster.n_reports,
        derived_confidence=conf,
        notes=(
            f"Auto-declared by pipeline. {cluster.n_reports} reports "
            f"clustered within {cluster.radius_m:.0f}m over "
            f"{cluster.time_span_seconds:.0f}s. Confidence {conf:.2f}."
        ),
        seed_report_id=cluster.seed_report_id,
        member_report_ids=[r.id for r in cluster.reports],
    )


def _consensus_severity(cluster: ReportCluster) -> SeverityStr:
    """Pick a severity from the cluster.

    Composition:
      1. Take the highest severity that ≥ 2 reports agree on (damps
         single-hyperbolic-transcript escalation per Trap 2b).
      2. Escalate by VOLUME: many corroborating reports = real incident,
         even if each individual transcript reads as "low". An LLM
         judging a single transcript can't see what 15 other citizens
         called in about the same thing — Python can.
    """
    counts: Dict[SeverityStr, int] = {"low": 0, "medium": 0, "high": 0, "critical": 0}
    for r in cluster.reports:
        sev = r.severity if r.severity in counts else "low"
        counts[sev] += 1  # type: ignore[index]

    # Step 1: highest severity with ≥ 2 agreement, fallback to majority.
    base: SeverityStr = "low"
    for sev in ("critical", "high", "medium", "low"):
        if counts[sev] >= 2:  # type: ignore[index]
            base = sev  # type: ignore[assignment]
            break
    else:
        most_common = max(counts.items(), key=lambda kv: kv[1])
        if most_common[1] > 0:
            base = most_common[0]  # type: ignore[assignment]

    # Step 2: volume-based escalation. Many witnesses = serious incident,
    # regardless of how each transcript reads in isolation. Casualty flag
    # on ANY report is a hard signal — bumps another notch.
    n = cluster.n_reports
    has_casualty = cluster.any_casualties

    ladder = ["low", "medium", "high", "critical"]
    idx = ladder.index(base)

    if n >= 10:
        idx = max(idx, ladder.index("medium"))
    if n >= 20:
        idx = max(idx, ladder.index("high"))
    if n >= 40 or has_casualty:
        idx = max(idx, ladder.index("high"))
    if has_casualty and n >= 10:
        idx = max(idx, ladder.index("critical"))

    return ladder[idx]  # type: ignore[return-value]


# Fire-truck dispatch planning lives in pipeline/dispatch_agent.py — the AI
# decides per-station counts based on the live capacity snapshot in
# WorldSlice. There is intentionally no plan_dispatch() function here.


# ── plan_cordon ─────────────────────────────────────────────────────────


def plan_cordon(incident: IncidentRef, *, existing_cordon: bool = False) -> Optional[CordonOrder]:
    """Plan a cordon around the incident, sized by severity.

    Skips if a cordon already exists for the incident (caller decides;
    pipeline.execute.py checks ``WorldSlice.nearby_cordons``).
    """
    if existing_cordon:
        return None

    sev_str = severity_int_to_str(incident.severity)
    radius = CORDON_RADIUS_BY_SEVERITY[sev_str]
    return CordonOrder(
        incident_id=incident.id,
        centroid_lat=incident.lat,
        centroid_lng=incident.lng,
        radius_m=radius,
        reason=f"{incident.disaster_type} ({sev_str})",
    )


# ── plan_alert ──────────────────────────────────────────────────────────


# Per disaster_type → (alert_severity, template).
_ALERT_TEMPLATES: Dict[str, tuple] = {
    "building_fire": (
        "warning",
        "Building fire reported near {place}. Avoid the area, do not enter, leave the building if you are inside.",
    ),
    "wildfire": (
        "warning",
        "Wildfire reported near {place}. Avoid the area and stay alert for evacuation guidance.",
    ),
    "flood": (
        "warning",
        "Flooding reported near {place}. Avoid low-lying areas and do not enter standing water.",
    ),
    "medical": (
        "advisory",
        "Medical emergency near {place}. Avoid blocking responders.",
    ),
    "other": (
        "advisory",
        "Incident reported near {place}. Stay alert and avoid the area.",
    ),
}


def plan_alert(incident: IncidentRef, *, place: Optional[str] = None) -> Optional[AlertOrder]:
    """Slot-fill a citizen alert for warning-or-higher incidents."""
    sev_str = severity_int_to_str(incident.severity)
    # Only generate alerts for medium-or-higher; low-severity is too noisy.
    if sev_str == "low":
        return None

    alert_sev, template = _ALERT_TEMPLATES.get(
        incident.disaster_type, _ALERT_TEMPLATES["other"]
    )

    # Critical incidents get escalated to evacuation severity.
    if sev_str == "critical":
        alert_sev = "evacuation"
        template = template.replace("Avoid the area", "EVACUATE the area")

    message = template.format(place=place or "the area")

    # Trap-driven check: warning/evacuation alerts MUST contain a directive verb.
    if alert_sev in ALERT_SEVERITIES_REQUIRING_DIRECTIVE:
        if not any(v in message.lower() for v in DIRECTIVE_VERBS):
            logger.warning(
                f"plan_alert: directive verb missing for {alert_sev}; falling back to advisory"
            )
            alert_sev = "advisory"

    return AlertOrder(
        incident_id=incident.id,
        severity=alert_sev,  # type: ignore[arg-type]
        message=message,
    )


# ── plan_response (bundle) ──────────────────────────────────────────────


async def plan_response(
    world: WorldSlice,
    *,
    place: Optional[str] = None,
    casualties_mentioned: bool = False,
    n_reports: int = 1,
    derived_confidence: float = 0.0,
    triage_rationale: Optional[str] = None,
) -> ResponsePlan:
    """Bundle dispatch + cordon + alert orders for one active incident.

    Dispatch counts come from the AI dispatch agent (one Vertex call).
    Cordon and alert are still deterministic — cordon radius is a fixed
    severity table, alert wording is a template — both flagged for future
    AI-isation but not in scope here.
    """
    from pipeline.dispatch_agent import decide_dispatch

    incident = world.incident
    severity_str = severity_int_to_str(incident.severity)

    dispatches, dispatch_rationale = await decide_dispatch(
        incident,
        world.nearby_stations,
        casualties_mentioned=casualties_mentioned,
        n_reports=n_reports,
        derived_confidence=derived_confidence,
        severity_str=severity_str,
        triage_rationale=triage_rationale,
    )

    # A cordon already exists if any active cordon is in the nearby slice.
    # (Cordons are city-scoped, so this is a soft check — execute.py does
    # the authoritative one with a row lock on the incident.)
    cordon = plan_cordon(incident, existing_cordon=bool(world.nearby_cordons))
    alert = plan_alert(incident, place=place)

    return ResponsePlan(
        incident_id=incident.id,
        dispatches=dispatches,
        cordon=cordon,
        alert=alert,
        rationale=(
            f"severity={severity_str} ({incident.severity}); "
            f"stations={len(world.nearby_stations)}; "
            f"nearby_reports={len(world.nearby_reports)}; "
            f"ai_dispatch: {dispatch_rationale}"
        ),
    )
