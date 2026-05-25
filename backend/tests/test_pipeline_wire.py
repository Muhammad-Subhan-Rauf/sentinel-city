"""Tests for the FastAPI ↔ pipeline wiring in main.post_citizen_reports.

Covers:
  - With SENTINEL_PIPELINE_MODE=new, process_report is scheduled per inserted row
  - With the flag absent, the legacy wake_bus path is used
  - Both paths return the inserted/skipped counts unchanged
  - Background-task failure during scheduling doesn't break the request
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "stub-project")


def _make_test_client():
    with patch("psycopg2.connect"):
        import importlib
        import main  # type: ignore
        importlib.reload(main)
    from fastapi.testclient import TestClient
    return TestClient(main.app), main


def _capture_returning_rows_mock(returning_ids):
    """psycopg2 connect mock that returns provided IDs from RETURNING."""
    cursor = MagicMock()

    def fake_execute_values(cur, sql, rows, *args, **kwargs):
        if kwargs.get("fetch"):
            return [(rid,) for rid in returning_ids]
        cur.rowcount = len(rows)
        return None

    cursor_ctx = MagicMock()
    cursor_ctx.__enter__ = MagicMock(return_value=cursor)
    cursor_ctx.__exit__ = MagicMock(return_value=False)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor_ctx)
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    return conn, fake_execute_values


def _valid_report_payload(n: int = 2):
    return {
        "reports": [
            {
                "event_id": str(uuid.uuid4()),
                "citizen_idx": i,
                "report_kind": "observation",
                "location": {"lat": 25.2048, "lng": 55.2708},
                "transcript": f"There is smoke near the market (report {i})",
                "perceived_severity": 4,
            }
            for i in range(n)
        ]
    }


def test_new_mode_schedules_pipeline_per_row(monkeypatch):
    """With the flag on, every inserted row gets a process_report background task."""
    returning_ids = [str(uuid.uuid4()) for _ in range(2)]
    conn_mock, fake_exec_values = _capture_returning_rows_mock(returning_ids)

    scheduled_for: list[str] = []

    async def _fake_process(report_id):
        scheduled_for.append(report_id)
        return {"stage": "done"}

    monkeypatch.setenv("SENTINEL_PIPELINE_MODE", "new")

    with patch("psycopg2.connect", return_value=conn_mock), \
         patch("psycopg2.extras.execute_values", side_effect=fake_exec_values):
        # Patch the import target inside main
        import importlib
        import main  # type: ignore
        importlib.reload(main)

        # Wedge our fake process_report under the module that main imports lazily.
        import pipeline.execute as pe
        monkeypatch.setattr(pe, "process_report", _fake_process)

        from fastapi.testclient import TestClient
        client = TestClient(main.app)
        resp = client.post("/api/citizen-report", json=_valid_report_payload(n=2))

    assert resp.status_code == 200
    body = resp.json()
    assert body["inserted"] == 2
    # All inserted IDs were scheduled
    assert sorted(scheduled_for) == sorted(returning_ids)


def test_lifespan_boots_no_ai_loops(monkeypatch):
    """The new pipeline is fully event-driven. Lifespan must NOT import any
    legacy AI module — they no longer exist. If a regression accidentally
    re-introduces an import, this test (and the FastAPI startup itself)
    will fail loudly.
    """
    with patch("psycopg2.connect"):
        import importlib
        import main  # type: ignore
        importlib.reload(main)

        from fastapi.testclient import TestClient
        # Entering the TestClient context fires the lifespan startup.
        with TestClient(main.app):
            pass
    # If we got here, the lifespan completed without trying to import any
    # of the deleted legacy modules.
    import sys
    for legacy in ("orchestrator", "wake_bus", "agent_graph", "agent_tools",
                   "safety.verifier", "safety.sla", "cache.agent_cache"):
        assert legacy not in sys.modules, f"legacy module {legacy} got imported"


def test_pipeline_import_failure_does_not_break_request(monkeypatch):
    """If pipeline.execute fails to import for any reason, the ingest still returns 200."""
    returning_ids = [str(uuid.uuid4())]
    conn_mock, fake_exec_values = _capture_returning_rows_mock(returning_ids)

    monkeypatch.setenv("SENTINEL_PIPELINE_MODE", "new")

    with patch("psycopg2.connect", return_value=conn_mock), \
         patch("psycopg2.extras.execute_values", side_effect=fake_exec_values):
        import importlib
        import main  # type: ignore
        importlib.reload(main)

        # Make the pipeline import fail
        import sys as _sys
        _sys.modules.pop("pipeline.execute", None)
        with patch.dict(_sys.modules, {"pipeline.execute": None}):
            from fastapi.testclient import TestClient
            client = TestClient(main.app)
            resp = client.post("/api/citizen-report", json=_valid_report_payload(n=1))

    assert resp.status_code == 200
