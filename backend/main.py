"""
Sentinel-City — FastAPI Backend
================================
Handles authenticated disaster event ingestion and persists data to Supabase.
"""

import os
import jwt
from fastapi import FastAPI, Depends, HTTPException, Header, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, Optional
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Sentinel-City API",
    description="Agentic disaster orchestration backend",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------

SUPABASE_URL: str = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY: str = os.environ["SUPABASE_SERVICE_KEY"]
SUPABASE_JWT_SECRET: str = os.environ["SUPABASE_JWT_SECRET"]

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class DisasterPayload(BaseModel):
    """Validated request body for triggering a disaster event."""

    disaster_type: str = Field(
        ...,
        description="Category of disaster (e.g. 'Earthquake', 'Flood', 'Wildfire')",
        examples=["Earthquake"],
    )
    severity: int = Field(
        ...,
        ge=1,
        le=10,
        description="Severity score from 1 (minor) to 10 (catastrophic)",
    )
    geometry: Dict[str, Any] = Field(
        ...,
        description="GeoJSON geometry object representing the affected area",
    )
    notes: Optional[str] = Field(
        default=None,
        description="Optional operator notes attached to the event",
    )


# ---------------------------------------------------------------------------
# Auth dependency — Supabase JWT verification
# ---------------------------------------------------------------------------


async def verify_user(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """
    Decodes and verifies the Supabase JWT from the Authorization header.
    Raises HTTP 401 if the token is missing, malformed, or expired.
    """
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
        )

    token = authorization.split(" ", 1)[1]

    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired.",
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
        )


# ---------------------------------------------------------------------------
# Supabase admin client factory (service key bypasses RLS)
# ---------------------------------------------------------------------------


def get_supabase_admin() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/", tags=["Health"])
async def health_check():
    """Quick liveness probe."""
    return {"status": "online", "service": "Sentinel-City API"}


@app.post("/api/trigger-disaster", tags=["Disasters"])
async def trigger_disaster(
    payload: DisasterPayload,
    user: Dict[str, Any] = Depends(verify_user),
):
    """
    Receive an authenticated disaster event from the frontend, persist it to
    Supabase, and hand off to the AI orchestration layer.

    Requires: Authorization: Bearer <supabase_jwt>
    """

    # ------------------------------------------------------------------
    # ██████████████████████████████████████████████████████████████████
    # [ANTIGRAVITY AI TRIGGER POINT]
    #
    # This is where your AI agent logic will be injected.
    # At this point you have:
    #   - `user`    → decoded JWT payload (user ID, email, role, etc.)
    #   - `payload` → validated DisasterPayload (type, severity, geometry)
    #
    # Suggested agent hooks to add here:
    #   1. Call an LLM to classify impact zones from the geometry
    #   2. Spawn sub-agents to fetch real-time weather / seismic data
    #   3. Route notifications to emergency services via webhooks
    #   4. Update a real-time Supabase channel for live dashboard feeds
    #   5. Log agent reasoning traces to a separate `agent_logs` table
    #
    # Example:
    #   agent_result = await run_sentinel_agent(payload, user)
    # ██████████████████████████████████████████████████████████████████
    # ------------------------------------------------------------------

    supabase: Client = get_supabase_admin()

    record = {
        "triggered_by": user.get("sub"),          # Supabase user UUID
        "disaster_type": payload.disaster_type,
        "severity": payload.severity,
        "area_geometry": payload.geometry,         # GeoJSON → PostGIS jsonb
        "notes": payload.notes,
        "status": "active",
    }

    try:
        response = supabase.table("disaster_events").insert(record).execute()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database write failed: {exc}",
        )

    return {
        "success": True,
        "message": "Disaster event recorded. Sentinel agents activating.",
        "event_id": response.data[0]["id"] if response.data else None,
        "triggered_by": user.get("email"),
    }
