"""
Tests for POST /api/citizen-report — specifically the resilience of the batch
ingest to mixed valid/invalid event_id payloads. The original failure was that
a single non-UUID event_id (e.g. 'crime:356:1053') from the operator-triggered
robbery flow caused Postgres to reject the entire batch with a UUID parse
error and the API to return HTTP 500.

These tests mock psycopg2.connect so they don't require a live database and
verify both the response shape and which rows actually reach the INSERT.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

# Make `import main` work when pytest is run from anywhere in the repo.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")


def _make_test_client():
    """Build a FastAPI TestClient with the DB-bootstrap call mocked out so
    importing `main` doesn't try to connect to a real Postgres."""
    with patch("psycopg2.connect"):
        import importlib
        import main  # type: ignore
        importlib.reload(main)
    from fastapi.testclient import TestClient
    return TestClient(main.app), main


async def _noop_process_report(_report_id):
    """Stand-in for pipeline.execute.process_report so the BackgroundTask
    scheduled by POST /api/citizen-report doesn't try to hit a real DB
    during these handler-focused tests."""
    return {"stage": "test_stub"}


def _capture_rows_mock():
    """Returns (conn_mock, captured_rows_list). The mock replaces
    psycopg2.connect so the route's `with conn: with conn.cursor() as cur:`
    pattern works without a real DB, and execute_values appends each batch's
    rows to captured_rows_list for assertion."""
    captured = []
    cursor = MagicMock()

    def fake_execute_values(cur, sql, rows, *args, **kwargs):
        captured.extend(rows)
        cur.rowcount = len(rows)
        # The pipeline rewrite added RETURNING id so the new handler can
        # schedule per-row background tasks. With fetch=True, execute_values
        # returns the result rows. Each row tuple's first element is the UUID.
        if kwargs.get("fetch"):
            return [(r[0],) for r in rows]
        return None

    cursor_ctx = MagicMock()
    cursor_ctx.__enter__ = MagicMock(return_value=cursor)
    cursor_ctx.__exit__ = MagicMock(return_value=False)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor_ctx)
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)

    return conn, captured, fake_execute_values


def test_only_valid_uuids_are_inserted():
    client, main_mod = _make_test_client()
    conn, captured, fake_exec = _capture_rows_mock()
    valid_id = str(uuid.uuid4())
    payload = {
        "reports": [
            {
                "event_id": valid_id,
                "citizen_idx": 1,
                "report_kind": "observation",
                "location": {"lat": 40.78, "lng": -73.97},
                "transcript": "I see smoke.",
                "perceived_severity": 3,
            },
        ],
    }
    with patch.object(main_mod.psycopg2, "connect", return_value=conn), \
         patch.object(main_mod.psycopg2.extras, "execute_values", side_effect=fake_exec), \
         patch("pipeline.execute.process_report", side_effect=_noop_process_report):
        res = client.post("/api/citizen-report", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["inserted"] == 1
    assert body["skipped"] == 0
    assert len(captured) == 1
    # Row tuple: (id, event_id, citizen_idx, report_kind, location, transcript, perceived_severity)
    assert captured[0][1] == valid_id


def test_crime_synthetic_event_id_is_dropped_silently_not_500():
    """The original bug: a 'crime:<idx>:<t>' event_id from triggerRobbery
    caused Postgres to fail the entire batch with HTTP 500. After the fix,
    bad UUIDs are dropped silently and the batch succeeds."""
    client, main_mod = _make_test_client()
    conn, captured, fake_exec = _capture_rows_mock()
    payload = {
        "reports": [
            {
                "event_id": "crime:356:1053",
                "citizen_idx": 356,
                "report_kind": "observation",
                "location": {"lat": 40.78, "lng": -73.97},
                "transcript": "Robbery L2 reported — bystander injured at scene.",
                "perceived_severity": 2,
            },
        ],
    }
    with patch.object(main_mod.psycopg2, "connect", return_value=conn), \
         patch.object(main_mod.psycopg2.extras, "execute_values", side_effect=fake_exec), \
         patch("pipeline.execute.process_report", side_effect=_noop_process_report):
        res = client.post("/api/citizen-report", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["inserted"] == 0
    assert body["skipped"] == 1
    # No rows should have reached the DB.
    assert captured == []


def test_mixed_batch_keeps_valid_drops_invalid():
    """A batch with one good UUID and one synthetic crime id should accept
    the good one and silently drop the bad one — the operator's real
    disaster report must not be lost because a sibling row is malformed."""
    client, main_mod = _make_test_client()
    conn, captured, fake_exec = _capture_rows_mock()
    valid_id = str(uuid.uuid4())
    payload = {
        "reports": [
            {
                "event_id": valid_id,
                "citizen_idx": 1,
                "report_kind": "observation",
                "location": {"lat": 40.78, "lng": -73.97},
                "transcript": "I see fire.",
                "perceived_severity": 4,
            },
            {
                "event_id": "crime:99:42",
                "citizen_idx": 99,
                "report_kind": "observation",
                "location": {"lat": 40.79, "lng": -73.96},
                "transcript": "Robbery in progress.",
                "perceived_severity": 1,
            },
            {
                "event_id": "not-a-uuid-at-all",
                "citizen_idx": 7,
                "report_kind": "affected",
                "location": {"lat": 40.80, "lng": -73.95},
                "transcript": "Heat exhaustion.",
                "perceived_severity": 2,
            },
        ],
    }
    with patch.object(main_mod.psycopg2, "connect", return_value=conn), \
         patch.object(main_mod.psycopg2.extras, "execute_values", side_effect=fake_exec), \
         patch("pipeline.execute.process_report", side_effect=_noop_process_report):
        res = client.post("/api/citizen-report", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["inserted"] == 1
    assert body["skipped"] == 2
    # Only the valid-UUID row should have reached the DB.
    assert len(captured) == 1
    assert captured[0][1] == valid_id


def test_empty_batch_short_circuits_without_db():
    """Empty batch should never reach psycopg2.connect."""
    client, main_mod = _make_test_client()
    connect_mock = MagicMock()
    with patch.object(main_mod.psycopg2, "connect", connect_mock):
        res = client.post("/api/citizen-report", json={"reports": []})
    assert res.status_code == 200, res.text
    assert res.json()["inserted"] == 0
    connect_mock.assert_not_called()
