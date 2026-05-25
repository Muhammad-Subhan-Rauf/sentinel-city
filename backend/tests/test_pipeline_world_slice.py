"""Tests for backend/pipeline/world_slice.py.

Covers:
  - Each fetch_* helper with a mocked cursor
  - slice_for_incident composes them correctly
  - Returns None when the incident doesn't exist or lacks coordinates
  - SQL parameter ordering (lng FIRST, per pipeline._geom contract — Trap 3b)

The PostGIS expressions themselves are not executed — those are covered
by the integration test in test_pipeline_geo.py.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")

from pipeline.world_slice import (
    IncidentRef,
    WorldSlice,
    _fetch_incident,
    _fetch_stations,
    _fetch_cordons,
    _fetch_nearby_reports,
    slice_for_incident,
)


def _mock_conn(queue):
    """Build a conn whose cursor returns rows from a queue of fetchall results.

    Each .execute() consumes one queue entry; .fetchall returns it. For
    fetchone, the entry is the single row (or None).
    """
    cursor = MagicMock()
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)

    calls = []

    def _execute(sql, params=()):
        calls.append((sql, params))
        nxt = queue.pop(0) if queue else None
        cursor._next = nxt

    def _fetchone():
        nxt = cursor._next
        if nxt is None:
            return None
        if isinstance(nxt, list):
            return nxt[0] if nxt else None
        return nxt

    def _fetchall():
        nxt = cursor._next
        if nxt is None:
            return []
        if isinstance(nxt, list):
            return nxt
        return [nxt]

    cursor.execute = _execute
    cursor.fetchone = _fetchone
    cursor.fetchall = _fetchall

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn._calls = calls
    return conn


# ── _fetch_incident ─────────────────────────────────────────────────────


def test_fetch_incident_returns_ref_on_found():
    row = ("inc-1", "building_fire", 6, "active", "notes", 25.2048, 55.2708)
    conn = _mock_conn([row])
    ref = _fetch_incident(conn, "inc-1")
    assert ref is not None
    assert ref.id == "inc-1"
    assert ref.disaster_type == "building_fire"
    assert ref.severity == 6
    assert ref.lat == 25.2048
    assert ref.lng == 55.2708


def test_fetch_incident_returns_none_on_missing():
    conn = _mock_conn([None])
    assert _fetch_incident(conn, "missing") is None


def test_fetch_incident_returns_none_on_null_coords():
    row = ("inc-1", "building_fire", 6, "active", None, None, None)
    conn = _mock_conn([row])
    assert _fetch_incident(conn, "inc-1") is None


# ── _fetch_stations ─────────────────────────────────────────────────────


def test_fetch_stations_returns_sorted_by_distance():
    rows = [
        ("s1", "Central", 25.2049, 55.2709, 50.0),
        ("s2", "North",   25.2150, 55.2800, 1200.0),
    ]
    conn = _mock_conn([rows])
    stations = _fetch_stations(conn, lng_lat=(55.2708, 25.2048), k=3)
    assert len(stations) == 2
    assert stations[0].id == "s1"
    assert stations[0].dist_m == 50.0


def test_fetch_stations_passes_lng_first():
    """The single most important invariant — see Trap 3b."""
    conn = _mock_conn([[]])
    _fetch_stations(conn, lng_lat=(55.2708, 25.2048), k=3)
    # The first execute call's params should be (lng, lat, k)
    _sql, params = conn._calls[0]
    assert params == (55.2708, 25.2048, 3)


def test_fetch_stations_filters_null_rows():
    rows = [
        ("s1", "Central", 25.2049, 55.2709, 50.0),
        ("s2", "Bad", None, None, None),
    ]
    conn = _mock_conn([rows])
    stations = _fetch_stations(conn, lng_lat=(55.2708, 25.2048), k=3)
    assert len(stations) == 1


# ── _fetch_cordons ──────────────────────────────────────────────────────


def test_fetch_cordons_returns_active():
    rows = [
        ("c1", "wildfire spread", "active", {"type": "Polygon"}),
    ]
    conn = _mock_conn([rows])
    cordons = _fetch_cordons(conn)
    assert len(cordons) == 1
    assert cordons[0].id == "c1"
    assert cordons[0].reason == "wildfire spread"


# ── _fetch_nearby_reports ───────────────────────────────────────────────


def test_fetch_nearby_reports_passes_lng_first():
    conn = _mock_conn([[]])
    _fetch_nearby_reports(conn, lng_lat=(55.2708, 25.2048), radius_m=2000.0, max_reports=10)
    _sql, params = conn._calls[0]
    assert params == (55.2708, 25.2048, 2000.0, 10)


def test_fetch_nearby_reports_filters_null_coords():
    now = datetime(2026, 5, 25, tzinfo=timezone.utc)
    rows = [
        ("r1", now, "fire smoke", 25.2048, 55.2708, "building_fire", "medium", False),
        ("r2", now, "vague",      None,    None,    "other",         "low",    False),
    ]
    conn = _mock_conn([rows])
    out = _fetch_nearby_reports(conn, lng_lat=(55.2708, 25.2048), radius_m=2000.0, max_reports=10)
    assert len(out) == 1
    assert out[0].id == "r1"


# ── slice_for_incident composition ──────────────────────────────────────


def test_slice_for_incident_composes_all_fetches():
    inc_row = ("inc-1", "building_fire", 6, "active", "notes", 25.2048, 55.2708)
    station_rows = [("s1", "Central", 25.2049, 55.2709, 50.0)]
    cordon_rows: list = []
    report_rows = [
        (
            "r1",
            datetime(2026, 5, 25, tzinfo=timezone.utc),
            "fire downtown",
            25.2050,
            55.2710,
            "building_fire",
            "high",
            True,
        ),
    ]
    conn = _mock_conn([inc_row, station_rows, cordon_rows, report_rows])

    result = slice_for_incident(conn, "inc-1", radius_m=2000.0, k_stations=3, max_reports=25)

    assert isinstance(result, WorldSlice)
    assert isinstance(result.incident, IncidentRef)
    assert result.incident.id == "inc-1"
    assert len(result.nearby_stations) == 1
    assert len(result.nearby_cordons) == 0
    assert len(result.nearby_reports) == 1
    assert result.nearby_reports[0].casualties_mentioned is True


def test_slice_for_incident_returns_none_when_incident_missing():
    conn = _mock_conn([None])
    assert slice_for_incident(conn, "missing") is None
