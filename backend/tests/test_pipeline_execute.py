"""Tests for backend/pipeline/execute.py.

The pipeline executor has two distinct test surfaces:

  1. Unit-level: the pure-Python helpers (_geohash, _advisory_key,
     _plan_to_jsonable) — exercised in process and asserted directly.

  2. Locking semantics: the SELECT ... FOR UPDATE dispatch path is
     exercised against a mocked conn that records the lock SQL fragment;
     a real concurrency drill (plan §Verification step 9) requires a
     live Postgres and lives in the integration block at the bottom,
     gated on SENTINEL_PG_INTEGRATION.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")

from pipeline.decide import DispatchOrder, ResponsePlan, CordonOrder, AlertOrder
from pipeline.execute import (
    _advisory_key,
    _execute_dispatch_locked,
    _geohash,
    _plan_to_jsonable,
)


# ── Pure helpers ────────────────────────────────────────────────────────


def test_geohash_stable_for_dubai():
    a = _geohash(25.2048, 55.2708, precision=5)
    b = _geohash(25.2048, 55.2708, precision=5)
    assert a == b
    assert len(a) == 5


def test_geohash_nearby_points_share_prefix():
    """Geohash-5 cells are ~5 km²; points 100m apart should share the prefix."""
    a = _geohash(25.2048, 55.2708, precision=5)
    b = _geohash(25.2050, 55.2710, precision=5)
    assert a == b


def test_geohash_far_points_differ():
    a = _geohash(25.2048, 55.2708, precision=5)  # Dubai
    b = _geohash(24.4539, 54.3773, precision=5)  # Abu Dhabi, ~120km
    assert a != b


def test_advisory_key_is_int4_range():
    k = _advisory_key("declare:building_fire:t1cgr")
    assert 0 <= k < 0x80000000


def test_advisory_key_is_deterministic():
    a = _advisory_key("declare:building_fire:t1cgr")
    b = _advisory_key("declare:building_fire:t1cgr")
    assert a == b


def test_advisory_key_differs_per_input():
    a = _advisory_key("declare:building_fire:t1cgr")
    b = _advisory_key("declare:wildfire:t1cgr")
    assert a != b


def test_plan_to_jsonable_handles_full_plan():
    plan = ResponsePlan(
        incident_id="inc-1",
        dispatches=[DispatchOrder(station_id="s1", station_name="N", unit_type="firefighter", count=2)],
        cordon=CordonOrder(incident_id="inc-1", centroid_lat=25.2, centroid_lng=55.2, radius_m=400, reason="r"),
        alert=AlertOrder(incident_id="inc-1", severity="warning", message="Avoid the area"),
        rationale="test",
    )
    j = _plan_to_jsonable(plan)
    assert j["incident_id"] == "inc-1"
    assert j["dispatches"][0]["count"] == 2
    assert j["cordon"]["radius_m"] == 400
    assert j["alert"]["severity"] == "warning"


def test_plan_to_jsonable_handles_empty_plan():
    plan = ResponsePlan(incident_id="inc-1", dispatches=[], cordon=None, alert=None)
    j = _plan_to_jsonable(plan)
    assert j["dispatches"] == []
    assert j["cordon"] is None
    assert j["alert"] is None


# ── Dispatch locking path (mocked conn) ─────────────────────────────────


def _mock_conn_for_dispatch(*, station_total: int = 4, station_dispatched: int = 0, severity_int: int = 6):
    """Build a conn that:
      - Returns severity row first (incident severity)
      - Then the station row (FOR UPDATE select)
      - Then the target-coords row (incident centroid)
      - Then accepts the UPDATE and INSERT calls.
    """
    cursor = MagicMock()
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)

    queue = [
        (severity_int,),                                              # SELECT severity ...
        ("s1", 25.2, 55.2, station_total, station_dispatched),        # SELECT ... FOR UPDATE
        None,                                                          # UPDATE fire_stations (no fetch)
        (25.2, 55.2),                                                  # SELECT target centroid
    ]
    captured_sql = []

    def _execute(sql, params=()):
        captured_sql.append(sql.strip())
        cursor._next = queue.pop(0) if queue else None

    def _fetchone():
        return cursor._next

    cursor.execute = _execute
    cursor.fetchone = _fetchone

    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    conn.cursor = MagicMock(return_value=cursor)
    conn._sql = captured_sql
    return conn


def test_dispatch_locks_station_row():
    conn = _mock_conn_for_dispatch(station_total=4, station_dispatched=0)
    order = DispatchOrder(station_id="s1", station_name="N", unit_type="firefighter", count=2)
    result = _execute_dispatch_locked(conn, incident_id="inc-1", order=order)
    assert result is not None
    # Verify the lock SQL appeared
    assert any("FOR UPDATE" in s for s in conn._sql)


def test_dispatch_denied_when_no_capacity():
    """Critical property: if the FRESH read shows no capacity, policy denies and no INSERT happens."""
    conn = _mock_conn_for_dispatch(station_total=4, station_dispatched=4)  # 0 available
    order = DispatchOrder(station_id="s1", station_name="N", unit_type="firefighter", count=2)
    result = _execute_dispatch_locked(conn, incident_id="inc-1", order=order)
    assert result is None
    # No INSERT INTO active_dispatches was issued.
    assert not any("INSERT INTO active_dispatches" in s for s in conn._sql)


def test_dispatch_denied_over_severity_cap():
    """8 trucks requested for a medium incident — over the cap."""
    conn = _mock_conn_for_dispatch(station_total=10, station_dispatched=0, severity_int=4)  # medium
    order = DispatchOrder(station_id="s1", station_name="N", unit_type="firefighter", count=8)
    result = _execute_dispatch_locked(conn, incident_id="inc-1", order=order)
    assert result is None


def test_dispatch_returns_none_when_station_missing():
    """Missing station row — dispatch must fail clean, no crash."""
    cursor = MagicMock()
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)
    cursor.execute = lambda sql, params=(): None
    cursor.fetchone = MagicMock(side_effect=[(6,), None])
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    conn.cursor = MagicMock(return_value=cursor)

    order = DispatchOrder(station_id="ghost", station_name="?", unit_type="firefighter", count=1)
    assert _execute_dispatch_locked(conn, incident_id="inc-1", order=order) is None


# ── Integration: concurrency drill (opt-in via SENTINEL_PG_INTEGRATION) ─


_PG_URL = os.environ.get("SENTINEL_PG_INTEGRATION")


@pytest.mark.skipif(_PG_URL is None, reason="SENTINEL_PG_INTEGRATION not set")
def test_concurrency_drill_5_simultaneous_dispatches():
    """5 concurrent dispatches against a station with 3 trucks → exactly 3 succeed.

    Per plan §Verification step 9. Requires a live Postgres.
    """
    import threading
    import uuid

    import psycopg2

    setup = psycopg2.connect(_PG_URL)
    try:
        with setup:
            with setup.cursor() as cur:
                station_id = str(uuid.uuid4())
                incident_id = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO fire_stations (id, name, lat, lng, truck_count, trucks_dispatched) "
                    "VALUES (%s, 'TEST', 25.0, 55.0, 3, 0);",
                    (station_id,),
                )
                cur.execute(
                    "INSERT INTO disaster_events (id, disaster_type, severity, status) "
                    "VALUES (%s, 'building_fire', 6, 'active');",
                    (incident_id,),
                )
    finally:
        setup.close()

    successes = []
    lock = threading.Lock()

    def fire():
        conn = psycopg2.connect(_PG_URL)
        try:
            order = DispatchOrder(
                station_id=station_id, station_name="TEST",
                unit_type="firefighter", count=1,
            )
            r = _execute_dispatch_locked(conn, incident_id=incident_id, order=order)
            with lock:
                if r is not None:
                    successes.append(r)
        finally:
            conn.close()

    threads = [threading.Thread(target=fire) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(successes) == 3, f"expected 3 successful dispatches, got {len(successes)}"

    # Cleanup
    cleanup = psycopg2.connect(_PG_URL)
    try:
        with cleanup:
            with cleanup.cursor() as cur:
                cur.execute("DELETE FROM active_dispatches WHERE event_id = %s;", (incident_id,))
                cur.execute("DELETE FROM disaster_events WHERE id = %s;", (incident_id,))
                cur.execute("DELETE FROM fire_stations WHERE id = %s;", (station_id,))
    finally:
        cleanup.close()
