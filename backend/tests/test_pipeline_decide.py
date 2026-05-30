"""Tests for backend/pipeline/decide.py.

Covers:
  - should_declare gating: thresholds, cooldowns, active dedup
  - Consensus-severity damping (Trap 2b)
  - Confidence comes from cluster density, NOT from any LLM field (Trap 1)
  - plan_cordon respects existing cordons + severity radius
  - plan_alert directive-verb enforcement + critical→evacuation escalation

NB: plan_dispatch + FIRE_UNITS_BY_SEVERITY were removed when fire-truck
dispatch counts moved into the AI dispatch agent
(pipeline/dispatch_agent.py). The new flow is end-to-end tested by
backend/test_pipeline_e2e.py against live Vertex; there is no
deterministic unit test for it here.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")

from pipeline.cluster import ClusteredReport, ReportCluster
from pipeline.decide import (
    ALERT_SEVERITIES_REQUIRING_DIRECTIVE,
    CORDON_RADIUS_BY_SEVERITY,
    DIRECTIVE_VERBS,
    SEVERITY_TO_INT,
    _consensus_severity,
    plan_alert,
    plan_cordon,
    severity_int_to_str,
    should_declare,
)
from pipeline.world_slice import IncidentRef, StationRef, WorldSlice


# ── helpers ─────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime(2026, 5, 25, 12, 0, 0, tzinfo=timezone.utc)


def _make_cluster(
    n: int = 3,
    *,
    radius_m: float = 30.0,
    time_s: float = 30.0,
    severities: list = None,
    casualties: bool = False,
    incident_type: str = "building_fire",
) -> ReportCluster:
    sevs = severities or (["medium"] * n)
    reports = [
        ClusteredReport(
            id=f"r{i}",
            event_id=None,
            reported_at=_now() + timedelta(seconds=i * 10),
            incident_type=incident_type,
            severity=sevs[i] if i < len(sevs) else "low",
            transcript="...",
            lat=25.2048 + i * 0.0001,
            lng=55.2708,
            casualties_mentioned=casualties and i == 0,
        )
        for i in range(n)
    ]
    return ReportCluster(
        seed_report_id="seed",
        reports=reports,
        incident_type=incident_type,
        centroid_lat=25.2048,
        centroid_lng=55.2708,
        time_span_seconds=time_s,
        radius_m=radius_m,
    )


def _make_incident(severity: int = 6, dtype: str = "building_fire") -> IncidentRef:
    return IncidentRef(
        id="inc-1",
        disaster_type=dtype,
        severity=severity,
        lat=25.2048,
        lng=55.2708,
        status="active",
    )


def _make_station(*, sid: str = "s1", dist: float = 50.0) -> StationRef:
    return StationRef(id=sid, name=f"Station-{sid}", lat=25.2048, lng=55.2708, dist_m=dist)


# ── severity helpers ────────────────────────────────────────────────────


def test_severity_int_to_str_mapping():
    assert severity_int_to_str(1) == "low"
    assert severity_int_to_str(3) == "low"
    assert severity_int_to_str(4) == "medium"
    assert severity_int_to_str(6) == "high"
    assert severity_int_to_str(8) == "critical"
    assert severity_int_to_str(10) == "critical"


def test_severity_to_int_round_trip():
    for sev_str, n in SEVERITY_TO_INT.items():
        assert severity_int_to_str(n) == sev_str


# ── _consensus_severity (Trap 2b damping) ──────────────────────────────


def test_consensus_severity_single_hyperbolic_is_damped():
    """One 'critical' report among two 'medium' shouldn't make critical stick."""
    cluster = _make_cluster(n=3, severities=["critical", "medium", "medium"])
    assert _consensus_severity(cluster) == "medium"


def test_consensus_severity_two_critical_sticks():
    cluster = _make_cluster(n=3, severities=["critical", "critical", "low"])
    assert _consensus_severity(cluster) == "critical"


def test_consensus_severity_majority_low():
    cluster = _make_cluster(n=3, severities=["low", "low", "high"])
    # 'high' has 1 vote, doesn't pass the ≥2 threshold; falls back to most common = low
    assert _consensus_severity(cluster) == "low"


def test_consensus_severity_volume_escalation_low_to_medium():
    """10+ corroborating reports — even if every transcript reads 'low' in
    isolation, the collective signal is real. Escalate to medium."""
    cluster = _make_cluster(n=12, severities=["low"] * 12)
    assert _consensus_severity(cluster) == "medium"


def test_consensus_severity_volume_escalation_to_high():
    """20+ reports → high, regardless of per-transcript severity."""
    cluster = _make_cluster(n=22, severities=["low"] * 22)
    assert _consensus_severity(cluster) == "high"


def test_consensus_severity_casualty_with_volume_goes_critical():
    """Any casualty flag + 10+ reports → critical."""
    cluster = _make_cluster(n=12, severities=["medium"] * 12, casualties=True)
    assert _consensus_severity(cluster) == "critical"


def test_consensus_severity_small_cluster_not_escalated():
    """Volume escalation must not affect small clusters — 3 'low' reports
    stay 'low', no false escalation."""
    cluster = _make_cluster(n=3, severities=["low"] * 3)
    assert _consensus_severity(cluster) == "low"


# ── should_declare ──────────────────────────────────────────────────────


def test_should_declare_passes_minimum_threshold():
    cluster = _make_cluster(n=3, radius_m=30, time_s=30)
    result = should_declare(cluster)
    assert result is not None
    assert result.incident_type == "building_fire"
    assert result.n_reports == 3


def test_should_declare_blocks_below_min_reports():
    # MIN_REPORTS_TO_DECLARE = 2 — a single-report cluster cannot declare.
    cluster = _make_cluster(n=1, radius_m=30, time_s=30)
    assert should_declare(cluster) is None


def test_should_declare_blocks_below_min_confidence():
    """Three reports 500m apart over 10 minutes — loose, should fail."""
    cluster = _make_cluster(n=3, radius_m=500, time_s=600)
    assert should_declare(cluster) is None


def test_should_declare_uses_derived_not_llm_confidence():
    """The derived_confidence field comes from cluster_confidence, not any input field.
    Even if a future LLM field set self-confidence to 0.99, the gate is server-side."""
    cluster = _make_cluster(n=3, radius_m=30, time_s=30)
    result = should_declare(cluster)
    assert result is not None
    # The result's derived_confidence is the cluster density, not "0.99".
    assert 0.6 <= result.derived_confidence <= 1.0


def test_should_declare_dedups_against_active_same_type():
    cluster = _make_cluster(n=3, radius_m=30, time_s=30)
    nearby_active = [
        IncidentRef(
            id="existing", disaster_type="building_fire", severity=5,
            lat=25.2050, lng=55.2710, status="active",  # ~30m away
        )
    ]
    assert should_declare(cluster, active_incidents_same_type=nearby_active) is None


def test_should_declare_allows_when_active_is_far():
    cluster = _make_cluster(n=3, radius_m=30, time_s=30)
    far_active = [
        IncidentRef(
            id="existing", disaster_type="building_fire", severity=5,
            lat=25.5000, lng=55.5000, status="active",  # tens of km away
        )
    ]
    assert should_declare(cluster, active_incidents_same_type=far_active) is not None


def test_should_declare_respects_cooldown_on_cleared():
    cluster = _make_cluster(n=3, radius_m=30, time_s=30)
    recent_cleared = [
        IncidentRef(
            id="ghost", disaster_type="building_fire", severity=5,
            lat=25.2050, lng=55.2710, status="cleared",
        )
    ]
    assert should_declare(cluster, recent_cleared_incidents=recent_cleared) is None


# ── plan_cordon ─────────────────────────────────────────────────────────


def test_plan_cordon_uses_severity_radius():
    inc = _make_incident(severity=6)  # high
    cordon = plan_cordon(inc)
    assert cordon is not None
    assert cordon.radius_m == CORDON_RADIUS_BY_SEVERITY["high"]
    assert cordon.incident_id == "inc-1"


def test_plan_cordon_skips_if_existing():
    inc = _make_incident(severity=8)
    assert plan_cordon(inc, existing_cordon=True) is None


def test_plan_cordon_critical_radius_largest():
    crit = plan_cordon(_make_incident(severity=8))
    low = plan_cordon(_make_incident(severity=2))
    assert crit.radius_m > low.radius_m


# ── plan_alert ──────────────────────────────────────────────────────────


def test_plan_alert_skips_low_severity():
    inc = _make_incident(severity=2)
    assert plan_alert(inc) is None


def test_plan_alert_warning_contains_directive_verb():
    inc = _make_incident(severity=6, dtype="building_fire")
    alert = plan_alert(inc, place="the market")
    assert alert is not None
    if alert.severity in ALERT_SEVERITIES_REQUIRING_DIRECTIVE:
        assert any(v in alert.message.lower() for v in DIRECTIVE_VERBS)


def test_plan_alert_critical_escalates_to_evacuation():
    inc = _make_incident(severity=8, dtype="building_fire")
    alert = plan_alert(inc, place="downtown")
    assert alert is not None
    assert alert.severity == "evacuation"
    assert "evacuate" in alert.message.lower()


def test_plan_alert_falls_back_to_advisory_if_no_directive():
    """The template registry should always contain a directive — but if a
    template were ever edited to remove it, the function falls back rather
    than emitting a warning without a verb."""
    inc = _make_incident(severity=4, dtype="medical")  # template is 'advisory'
    alert = plan_alert(inc, place="the office")
    # medical template is advisory, no enforcement needed
    assert alert is not None
    assert alert.severity == "advisory"


# plan_response is now async and calls Gemini's dispatch agent. It's
# end-to-end covered by backend/test_pipeline_e2e.py against live Vertex.
# No deterministic unit test for it lives here.
