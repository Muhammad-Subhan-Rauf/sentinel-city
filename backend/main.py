"""
Sentinel-City — FastAPI Backend (no-auth mode)
"""

import os
import uuid
import json
import psycopg2
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, Optional
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Sentinel-City API",
    description="Agentic disaster orchestration backend",
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


class DisasterPayload(BaseModel):
    disaster_type: str = Field(..., examples=["Earthquake"])
    severity: int = Field(..., ge=1, le=10)
    geometry: Dict[str, Any]
    notes: Optional[str] = None


@app.get("/", tags=["Health"])
async def health_check():
    return {"status": "online", "service": "Sentinel-City API"}


@app.post("/api/trigger-disaster", tags=["Disasters"])
async def trigger_disaster(payload: DisasterPayload):
    """
    Accept a disaster event and persist it to Supabase PostgreSQL.
    """

    # ------------------------------------------------------------------
    # ██████████████████████████████████████████████████████████████████
    # [ANTIGRAVITY AI TRIGGER POINT]
    #
    # At this point you have:
    #   - `payload.disaster_type` — e.g. "Earthquake"
    #   - `payload.severity`      — 1–10
    #   - `payload.geometry`      — GeoJSON geometry dict
    #   - `payload.notes`         — optional operator notes
    #
    # Plug your AI agent logic here before or after the DB write.
    # ██████████████████████████████████████████████████████████████████
    # ------------------------------------------------------------------

    event_id = str(uuid.uuid4())

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO disaster_events
                        (id, disaster_type, severity, area_geometry, notes, status)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (
                        event_id,
                        payload.disaster_type,
                        payload.severity,
                        json.dumps(payload.geometry),
                        payload.notes,
                        "active",
                    ),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database write failed: {exc}",
        )

    return {
        "success": True,
        "message": "Disaster event recorded. Sentinel agents activating.",
        "event_id": str(returned_id),
    }
