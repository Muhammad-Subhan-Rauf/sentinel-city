"""Tests for backend/pipeline/cluster.py.

Covers:
  - cluster_confidence formula across the matrix of (n, radius, time, casualties)
  - _summarize centroid/radius/time math
  - find_cluster SQL path with a mocked cursor (no real DB needed)
  - haversine sanity check against known city distances

The PostGIS query itself can't be exercised without a real DB — the
SRID smoke test in test_pipeline_geo.py covers that side.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")

from pipeline.cluster import (
    ClusteredReport,
    MIN_CLUSTER_CONFIDENCE,
    MIN_REPORTS_TO_DECLARE,
    ReportCluster,
    _haversine_m,
    _summarize,
    cluster_confidence,
    find_cluster,
)


# ── Test fixtures ───────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime(2026, 5, 25, 12, 0, 0, tzinfo=timezone.utc)


def _report(
    *,
    rid: str = "r1",
    lat: float = 25.2048,
    lng: float = 55.2708,
    offset_s: int = 0,
    incident_type: str = "building_fire",
    severity: str = "medium",
    casualties: bool = False,
) -> ClusteredReport:
    return ClusteredReport(
        id=rid,
        event_id=None,
        reported_at=_now() + timedelta(seconds=offset_s),
        incident_type=incident_type,
        severity=severity,
        transcript="...",
        lat=lat,
        lng=lng,
        casualties_mentioned=casualties,
    )


# ── Haversine sanity ────────────────────────────────────────────────────


def test_haversine_dubai_to_dubai_is_zero():
    d = _haversine_m(25.2048, 55.2708, 25.2048, 55.2708)
    assert d < 0.001


def test_haversine_known_distance_about_right():
    # Dubai → Abu Dhabi is ~120 km
    d = _haversine_m(25.2048, 55.2708, 24.4539, 54.3773)
    assert 110_000 < d < 130_000


def test_haversine_meter_scale():
    # ~100m offset at Dubai latitude
    d = _haversine_m(25.2048, 55.2708, 25.2057, 55.2708)
    assert 90 < d < 110


# ── _summarize ──────────────────────────────────────────────────────────


def test_summarize_single_report():
    reports = [_report()]
    c = _summarize("seed", reports)
    assert c.n_reports == 1
    assert c.radius_m == 0.0
    assert c.time_span_seconds == 0.0
    assert c.centroid_lat == 25.2048
    assert c.centroid_lng == 55.2708
    assert c.incident_type == "building_fire"


def test_summarize_three_tight_reports():
    reports = [
        _report(rid="r1", lat=25.2048, lng=55.2708, offset_s=0),
        _report(rid="r2", lat=25.2050, lng=55.2710, offset_s=30),
        _report(rid="r3", lat=25.2046, lng=55.2706, offset_s=60),
    ]
    c = _summarize("seed", reports)
    assert c.n_reports == 3
    assert c.radius_m < 50  # tight cluster
    assert c.time_span_seconds == 60.0
    assert abs(c.centroid_lat - 25.2048) < 0.001


def test_summarize_majority_vote_on_incident_type():
    reports = [
        _report(rid="r1", incident_type="building_fire"),
        _report(rid="r2", incident_type="building_fire"),
        _report(rid="r3", incident_type="wildfire"),  # outlier
    ]
    c = _summarize("seed", reports)
    assert c.incident_type == "building_fire"


# ── cluster_confidence ──────────────────────────────────────────────────


def _cluster(n: int, *, radius_m: float = 30, time_s: float = 30, casualties: bool = False) -> ReportCluster:
    return ReportCluster(
        seed_report_id="seed",
        reports=[_report(rid=f"r{i}", casualties=casualties and i == 0) for i in range(n)],
        incident_type="building_fire",
        centroid_lat=25.2048,
        centroid_lng=55.2708,
        time_span_seconds=time_s,
        radius_m=radius_m,
    )


def test_confidence_zero_for_empty_cluster():
    empty = ReportCluster(seed_report_id="seed")
    assert cluster_confidence(empty) == 0.0


def test_confidence_low_for_single_report():
    c = _cluster(1, radius_m=0, time_s=0)
    assert cluster_confidence(c) < MIN_CLUSTER_CONFIDENCE


def test_confidence_passes_threshold_at_three_tight_reports():
    c = _cluster(3, radius_m=30, time_s=30)
    assert cluster_confidence(c) >= MIN_CLUSTER_CONFIDENCE


def test_confidence_capped_at_one():
    c = _cluster(10, radius_m=10, time_s=10, casualties=True)
    assert cluster_confidence(c) <= 1.0


def test_confidence_higher_with_more_reports():
    c1 = _cluster(1)
    c5 = _cluster(5)
    assert cluster_confidence(c5) > cluster_confidence(c1)


def test_confidence_higher_with_tighter_radius():
    tight = _cluster(3, radius_m=20)
    loose = _cluster(3, radius_m=500)
    assert cluster_confidence(tight) > cluster_confidence(loose)


def test_confidence_higher_with_tighter_time_window():
    tight = _cluster(3, time_s=30)
    loose = _cluster(3, time_s=600)
    assert cluster_confidence(tight) > cluster_confidence(loose)


def test_confidence_higher_with_casualties():
    no_cas = _cluster(3, casualties=False)
    yes_cas = _cluster(3, casualties=True)
    assert cluster_confidence(yes_cas) > cluster_confidence(no_cas)


def test_confidence_below_threshold_for_two_loose_reports():
    """Two reports 500m apart over 10 minutes is noise, not a cluster."""
    c = _cluster(2, radius_m=500, time_s=600)
    assert cluster_confidence(c) < MIN_CLUSTER_CONFIDENCE


# ── find_cluster (mocked cursor; no DB) ─────────────────────────────────


def _mock_conn(rows):
    """Build a psycopg2-ish connection mock that returns the given rows
    from any cursor.execute(...)/fetchall pair."""
    cursor = MagicMock()
    cursor.fetchall = MagicMock(return_value=rows)
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)
    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    return conn, cursor


def test_find_cluster_returns_none_when_no_rows():
    conn, _ = _mock_conn([])
    assert find_cluster(conn, "seed-id") is None


def test_find_cluster_builds_cluster_from_rows():
    rows = [
        ("r1", None, _now(),                       "building_fire", "medium", "smoke at the market", 25.2048, 55.2708, False),
        ("r2", None, _now() + timedelta(seconds=30), "building_fire", "high",   "flames coming out",    25.2050, 55.2710, True),
        ("r3", None, _now() + timedelta(seconds=60), "building_fire", "medium", "smoke spreading",      25.2046, 55.2706, False),
    ]
    conn, cur = _mock_conn(rows)
    cluster = find_cluster(conn, "r1", radius_m=100, time_window_s=300)
    assert cluster is not None
    assert cluster.n_reports == 3
    assert cluster.incident_type == "building_fire"
    assert cluster.any_casualties is True
    # SQL was called with the expected (id, radius, window) params
    args = cur.execute.call_args[0]
    assert args[1] == ("r1", 100, 300)


def test_find_cluster_drops_rows_with_missing_coords():
    rows = [
        ("r1", None, _now(), "flood", "low", "ok", 25.2, 55.2, False),
        ("r2", None, _now(), "flood", "low", "ok", None, None, False),  # bad row
    ]
    conn, _ = _mock_conn(rows)
    cluster = find_cluster(conn, "r1")
    assert cluster is not None
    assert cluster.n_reports == 1  # the bad row was dropped
