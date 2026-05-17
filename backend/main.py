"""
Sentinel-City — FastAPI Backend (no-auth mode)
"""

import os
import uuid
import json
import psycopg2
import psycopg2.extras
from datetime import datetime
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Literal, Optional
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Sentinel-City API",
    description="Municipal emergency orchestration backend",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL: str = os.environ["DATABASE_URL"]


# Self-bootstrap the citizen_reports table on startup so deployments don't
# require manually running migration files. Idempotent.
CITIZEN_REPORTS_DDL = """
CREATE TABLE IF NOT EXISTS citizen_reports (
    id                 UUID PRIMARY KEY,
    event_id           UUID NOT NULL,
    citizen_idx        INTEGER NOT NULL,
    reported_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    report_kind        TEXT NOT NULL CHECK (report_kind IN ('observation', 'affected')),
    location           JSONB NOT NULL,
    transcript         TEXT NOT NULL,
    perceived_severity INTEGER
);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_event
    ON citizen_reports (event_id);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_recent
    ON citizen_reports (reported_at DESC);
"""


def _bootstrap_schema() -> None:
    """Ensure required tables exist. Called once at module import."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(CITIZEN_REPORTS_DDL)
                # If the table was created in a prior version with a foreign-key
                # constraint to disaster_events, drop it — citizen reports
                # reference in-memory zone IDs that aren't persisted unless the
                # operator clicks Trigger, so the FK would block every write.
                cur.execute("""
                    ALTER TABLE citizen_reports
                    DROP CONSTRAINT IF EXISTS citizen_reports_event_id_fkey;
                """)
        conn.close()
        print("[schema] citizen_reports ready.")
    except Exception as exc:
        print(f"[schema] bootstrap warning: {exc}")


_bootstrap_schema()


# Per-type severity ceilings — mirror the frontend DISASTER_PROFILES.
# Updating one means updating both (the duplication is intentional; sharing
# this through the API isn't worth the complexity at this scale).
SEVERITY_MAX_BY_TYPE = {
    "Flood": 5,
    "Wildfire": 5,
    "Heatwave": 4,
    "Power_Outage": 3,
    "Robbery": 4,
    "Gang_Violence": 5,
    "Accident": 4,
    "Road_Blockage": 3,
    "Infrastructure_Failure": 4,
}


class DisasterPayload(BaseModel):
    disaster_type: str = Field(..., examples=["Flood"])
    severity: int = Field(..., ge=1, le=10)
    # geometry is None for city-wide events (Heatwave, Power_Outage citywide).
    geometry: Optional[Dict[str, Any]] = None
    # 'point' | 'area' | 'city'. Optional for backward compatibility.
    geometry_kind: Optional[Literal["point", "area", "city"]] = None
    notes: Optional[str] = None


class CitizenReport(BaseModel):
    """A single 911-style report produced by the citizen simulation."""
    event_id: str
    citizen_idx: int = Field(..., ge=0)
    report_kind: Literal["observation", "affected"]
    location: Dict[str, float]  # { "lat": float, "lng": float }
    transcript: str
    perceived_severity: Optional[int] = None


class CitizenReportBatch(BaseModel):
    reports: List[CitizenReport]


@app.get("/", tags=["Health"])
async def health_check():
    return {"status": "online", "service": "Sentinel-City API"}


@app.post("/api/trigger-disaster", tags=["Disasters"])
async def trigger_disaster(payload: DisasterPayload):
    """
    Accept a municipal emergency event and persist it to Supabase PostgreSQL.
    """

    # ------------------------------------------------------------------
    # ██████████████████████████████████████████████████████████████████
    # [ANTIGRAVITY AI TRIGGER POINT]
    #
    # At this point you have:
    #   - `payload.disaster_type` — e.g. "Flood", "Wildfire", "Power_Outage"
    #   - `payload.severity`      — 1–10
    #   - `payload.geometry`      — GeoJSON geometry dict
    #   - `payload.notes`         — optional operator notes
    #
    # Plug your AI agent logic here before or after the DB write.
    # ██████████████████████████████████████████████████████████████████
    # ------------------------------------------------------------------

    # Per-type severity enforcement (DB still allows 1..10 globally; this is
    # the type-aware ceiling that mirrors the frontend profile registry).
    max_sev = SEVERITY_MAX_BY_TYPE.get(payload.disaster_type)
    if max_sev is not None and payload.severity > max_sev:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Severity {payload.severity} exceeds max ({max_sev}) for {payload.disaster_type}.",
        )

    # Citywide events have no geometry; everything else must provide one.
    if payload.geometry_kind != "city" and payload.geometry is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="geometry is required unless geometry_kind is 'city'.",
        )

    event_id = str(uuid.uuid4())

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO disaster_events
                        (id, disaster_type, severity, area_geometry, geometry_kind, notes, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (
                        event_id,
                        payload.disaster_type,
                        payload.severity,
                        json.dumps(payload.geometry) if payload.geometry is not None else None,
                        payload.geometry_kind,
                        payload.notes,
                        "active",
                    ),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database write failed: {exc}",
        )

    return {
        "success": True,
        "message": "Emergency recorded. Sentinel units dispatched.",
        "event_id": str(returned_id),
    }


@app.post("/api/citizen-report", tags=["Citizen Reports"])
async def post_citizen_reports(batch: CitizenReportBatch):
    """
    Batch-ingest 911 reports from the citizen simulation. Each report references
    an existing disaster_events.id; rows for unknown event_ids are dropped silently
    (the citizen sim may emit slightly stale references after a zone removal).
    """
    if not batch.reports:
        return {"inserted": 0}

    rows = [
        (
            str(uuid.uuid4()),
            r.event_id,
            r.citizen_idx,
            r.report_kind,
            json.dumps(r.location),
            r.transcript,
            r.perceived_severity,
        )
        for r in batch.reports
    ]

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO citizen_reports
                        (id, event_id, citizen_idx, report_kind, location, transcript, perceived_severity)
                    VALUES %s
                    ON CONFLICT DO NOTHING;
                    """,
                    rows,
                )
                inserted = cur.rowcount
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Citizen report write failed: {exc}",
        )

    return {"inserted": inserted}


@app.get("/api/citizen-reports", tags=["Citizen Reports"])
async def get_citizen_reports(
    since: Optional[datetime] = Query(None, description="Return reports newer than this timestamp (ISO 8601)."),
    limit: int = Query(200, ge=1, le=1000),
):
    """
    Read recent citizen reports, optionally filtered to those after `since`.
    Intended for AI consumers polling the stream; the frontend uses its in-memory copy.
    """
    where = ""
    params: List[Any] = []
    if since is not None:
        where = "WHERE reported_at > %s"
        params.append(since)
    params.append(limit)

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, event_id, citizen_idx, reported_at, report_kind, location, transcript, perceived_severity
                    FROM citizen_reports
                    {where}
                    ORDER BY reported_at DESC
                    LIMIT %s;
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Citizen report read failed: {exc}",
        )

    return {
        "reports": [
            {
                "id": str(r[0]),
                "event_id": str(r[1]),
                "citizen_idx": r[2],
                "reported_at": r[3].isoformat(),
                "report_kind": r[4],
                "location": r[5],
                "transcript": r[6],
                "perceived_severity": r[7],
            }
            for r in rows
        ]
    }
