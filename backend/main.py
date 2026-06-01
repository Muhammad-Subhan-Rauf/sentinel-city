"""
Sentinel-City — FastAPI Backend (no-auth mode)
"""

import asyncio
import hashlib
import logging
import os
import time
import uuid
import json
import math
import psycopg2
import psycopg2.extras
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Literal, Optional, Tuple
from dotenv import load_dotenv

import cctv

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan — no-op.

    The legacy ReAct orchestrator (Detection + Monitoring loops, SLA watchdog,
    weather/traffic watchers, wake bus) has been removed. AI activity is
    fully event-driven: POST /api/citizen-report → BackgroundTask →
    pipeline.execute.process_report. No polling, no heartbeat, no LLM
    activity unless a citizen report arrives.
    """
    log = logging.getLogger("sentinel.lifespan")
    log.info("Sentinel-City API ready. AI pipeline is event-driven via POST /api/citizen-report.")
    yield


app = FastAPI(
    title="Sentinel-City API",
    description="Municipal emergency orchestration backend",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # Web dev (Vite) + mobile dev. Expo Go and React Native debug clients fetch
    # without an Origin header, so wildcard is required for those to work.
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Observability (#8) ──────────────────────────────────────────────────────
# Error tracking is opt-in via SENTRY_DSN — a no-op when the env var is unset or
# the SDK isn't installed, so it never blocks local dev.
_http_log = logging.getLogger("sentinel.http")
_SENTRY_DSN = os.environ.get("SENTRY_DSN")
if _SENTRY_DSN:
    try:
        import sentry_sdk  # type: ignore

        sentry_sdk.init(dsn=_SENTRY_DSN, traces_sample_rate=float(os.environ.get("SENTRY_TRACES", "0.1")))
        _http_log.info("Sentry error tracking enabled")
    except Exception as exc:  # pragma: no cover - sentry is optional
        _http_log.warning("SENTRY_DSN set but Sentry could not initialise: %s", exc)


@app.middleware("http")
async def _timing_middleware(request, call_next):
    """Time every request, surface it as X-Response-Time-ms, and log the slow
    ones so the chronically-slow endpoints (/api/warnings/nearby etc.) are easy
    to spot in production logs."""
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    response.headers["X-Response-Time-ms"] = f"{elapsed_ms:.0f}"
    if elapsed_ms > 1000.0:
        _http_log.warning("slow request %s %s %.0fms -> %s", request.method, request.url.path, elapsed_ms, response.status_code)
    return response


# ── Rate limiting (#7) ──────────────────────────────────────────────────────
# Lightweight in-process fixed-window limiter. Keyed per (scope, client) so one
# abuser can't spam a path. Intentionally generous — a real 911 caller must
# never be blocked; this only stops obvious flooding. (At multi-instance scale
# this moves to Redis; see the scaling notes.)
_rate_buckets: Dict[str, List[float]] = {}


def _rate_limit(key: str, max_events: int, window_s: float) -> None:
    now = time.monotonic()
    cutoff = now - window_s
    bucket = _rate_buckets.setdefault(key, [])
    # Drop timestamps outside the window.
    i = 0
    while i < len(bucket) and bucket[i] < cutoff:
        i += 1
    if i:
        del bucket[:i]
    if len(bucket) >= max_events:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests — please wait a moment and try again.",
        )
    bucket.append(now)


# ── Idempotency (#6) ────────────────────────────────────────────────────────
# Maps a client-supplied idempotency key → the call id it created, so a retried
# 911 submission (flaky network, double-tap) returns the SAME call instead of
# dispatching a duplicate. Bounded so it can't grow without limit.
_IDEMPOTENCY: Dict[str, str] = {}
_IDEMPOTENCY_ORDER: List[str] = []


def _remember_idempotency(key: str, call_id: str) -> None:
    if key in _IDEMPOTENCY:
        return
    _IDEMPOTENCY[key] = call_id
    _IDEMPOTENCY_ORDER.append(key)
    if len(_IDEMPOTENCY_ORDER) > 1000:
        old = _IDEMPOTENCY_ORDER.pop(0)
        _IDEMPOTENCY.pop(old, None)


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

                # Pipeline schema (migration db/009_pipeline.sql, idempotent).
                # PostGIS for spatial clustering, geom column on citizen_reports,
                # nlu_extraction + declared_incident_id stamps, nlu_cache memo.
                cur.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
                cur.execute("""
                    ALTER TABLE citizen_reports
                    ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);
                """)
                cur.execute("""
                    UPDATE citizen_reports
                    SET geom = ST_SetSRID(
                        ST_MakePoint(
                            (location->>'lng')::double precision,
                            (location->>'lat')::double precision
                        ),
                        4326
                    )::geography
                    WHERE geom IS NULL
                      AND location ? 'lat'
                      AND location ? 'lng'
                      AND (location->>'lat') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      AND (location->>'lng') ~ '^-?[0-9]+(\\.[0-9]+)?$';
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_citizen_reports_geom
                        ON citizen_reports USING GIST (geom);
                """)
                cur.execute("""
                    ALTER TABLE citizen_reports
                    ADD COLUMN IF NOT EXISTS declared_incident_id UUID;
                """)
                cur.execute("""
                    ALTER TABLE citizen_reports
                    ADD COLUMN IF NOT EXISTS nlu_extraction JSONB;
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_citizen_reports_undeclared
                        ON citizen_reports (reported_at)
                        WHERE declared_incident_id IS NULL;
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS nlu_cache (
                        transcript_hash TEXT PRIMARY KEY,
                        model_version   TEXT NOT NULL,
                        extraction      JSONB NOT NULL,
                        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_nlu_cache_created
                        ON nlu_cache (created_at);
                """)
                # Make sure disaster_events has the location_estimate column
                # the pipeline writes when declaring an incident.
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS location_estimate JSONB;
                """)
                # Link cordons to the incident they were raised for so
                # DELETE /api/disasters/{id} can also clear them.
                cur.execute("""
                    ALTER TABLE cordons
                    ADD COLUMN IF NOT EXISTS event_id UUID;
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_cordons_event
                        ON cordons (event_id)
                        WHERE event_id IS NOT NULL;
                """)
                # Self-heal disaster_events schema for DBs (e.g. Supabase) that
                # don't run the db/*.sql migration files. Idempotent.
                cur.execute("""
                    ALTER TABLE disaster_events
                    ALTER COLUMN area_geometry DROP NOT NULL;
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS geometry_kind TEXT
                    CHECK (geometry_kind IN ('point', 'area', 'city'));
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS notes TEXT;
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS cause TEXT
                    CHECK (cause IN ('weather', 'infrastructure'));
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS spread_speed REAL NOT NULL DEFAULT 1.0;
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS people_inside INTEGER;
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS safe_exit_pct REAL CHECK (safe_exit_pct BETWEEN 0 AND 100);
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS parent_id UUID;
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS spread_in_seconds INTEGER;
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS fire_stations (
                        id         UUID PRIMARY KEY,
                        name       TEXT,
                        lat        DOUBLE PRECISION NOT NULL,
                        lng        DOUBLE PRECISION NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS notifications (
                        id         UUID PRIMARY KEY,
                        geometry   JSONB NOT NULL,
                        reason     TEXT NOT NULL,
                        status     TEXT NOT NULL DEFAULT 'active',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                cur.execute("""
                    ALTER TABLE notifications
                    ADD COLUMN IF NOT EXISTS event_id UUID;
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_notifications_active
                        ON notifications (status)
                        WHERE status = 'active';
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS cordons (
                        id         UUID PRIMARY KEY,
                        geometry   JSONB NOT NULL,
                        reason     TEXT,
                        status     TEXT NOT NULL DEFAULT 'active',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                cur.execute("""
                    ALTER TABLE cordons
                    ADD COLUMN IF NOT EXISTS event_id UUID;
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_cordons_active
                        ON cordons (status)
                        WHERE status = 'active';
                """)
                # source column distinguishes AI-generated warnings (the
                # orchestrator's publish_citizen_alert/create_cordon/declare_incident
                # tools) from operator-drawn dashboard entries. The mobile app
                # filters to source='ai'; the dashboard reads everything.
                cur.execute("""
                    ALTER TABLE notifications
                    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator';
                """)
                cur.execute("""
                    ALTER TABLE cordons
                    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator';
                """)
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator';
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS active_dispatches (
                        id           UUID PRIMARY KEY,
                        event_id     UUID,
                        service_type TEXT NOT NULL,
                        target_lat   DOUBLE PRECISION NOT NULL,
                        target_lng   DOUBLE PRECISION NOT NULL,
                        radius_m     DOUBLE PRECISION NOT NULL DEFAULT 1500,
                        unit_count   INTEGER,
                        status       TEXT NOT NULL DEFAULT 'active',
                        source       TEXT NOT NULL DEFAULT 'ai',
                        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours'
                    );
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_active_dispatches_live
                        ON active_dispatches (status, expires_at)
                        WHERE status = 'active';
                """)
                cur.execute("""
                    ALTER TABLE fire_stations
                    ADD COLUMN IF NOT EXISTS truck_count INTEGER NOT NULL DEFAULT 4;
                """)
                cur.execute("""
                    ALTER TABLE fire_stations
                    ADD COLUMN IF NOT EXISTS trucks_dispatched INTEGER NOT NULL DEFAULT 0;
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS hospitals (
                        id                    UUID PRIMARY KEY,
                        name                  TEXT,
                        lat                   DOUBLE PRECISION NOT NULL,
                        lng                   DOUBLE PRECISION NOT NULL,
                        ambulance_count       INTEGER NOT NULL DEFAULT 3,
                        ambulances_dispatched INTEGER NOT NULL DEFAULT 0,
                        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS police_stations (
                        id                UUID PRIMARY KEY,
                        name              TEXT,
                        lat               DOUBLE PRECISION NOT NULL,
                        lng               DOUBLE PRECISION NOT NULL,
                        police_count      INTEGER NOT NULL DEFAULT 10,
                        police_dispatched INTEGER NOT NULL DEFAULT 0,
                        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                """)
                # Responder field reports — see plan §"Sentinel-City: Responder
                # Field Reports". Two kinds in one table: 'casualty_*' emitted
                # automatically as a fire's burning area recedes, and
                # 'fire_sighted' for the en-route correction path.
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS responder_reports (
                        id                 UUID PRIMARY KEY,
                        event_id           UUID,
                        responder_unit_id  TEXT NOT NULL,
                        report_kind        TEXT NOT NULL CHECK (report_kind IN (
                            'casualty_injured', 'casualty_fainted',
                            'casualty_critical', 'fire_sighted'
                        )),
                        location           JSONB NOT NULL,
                        severity           INTEGER,
                        is_correction      BOOLEAN NOT NULL DEFAULT FALSE,
                        notes              TEXT,
                        status             TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'resolved')),
                        reported_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        resolved_at        TIMESTAMPTZ
                    );
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_responder_reports_pending
                        ON responder_reports (status, reported_at DESC)
                        WHERE status = 'pending';
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_responder_reports_event
                        ON responder_reports (event_id);
                """)
                # AI-visible corrected location (set by the fire_sighted
                # correction path). Read by sync_state_with_disasters and
                # surfaced into the agent's context via agent_view().
                cur.execute("""
                    ALTER TABLE disaster_events
                    ADD COLUMN IF NOT EXISTS location_estimate JSONB;
                """)
                # 911 calls — persisted so the live call log + per-service lanes
                # survive restarts and can be shared across instances (see db/010).
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS emergency_calls (
                        id                 UUID PRIMARY KEY,
                        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        citizen_id         TEXT NOT NULL,
                        citizen_name       TEXT,
                        caller_lat         DOUBLE PRECISION,
                        caller_lng         DOUBLE PRECISION,
                        disaster_id        TEXT,
                        disaster_type      TEXT,
                        severity           INTEGER,
                        cause              TEXT,
                        disaster_lat       DOUBLE PRECISION,
                        disaster_lng       DOUBLE PRECISION,
                        is_direct          BOOLEAN NOT NULL DEFAULT FALSE,
                        category           TEXT,
                        transcript         TEXT,
                        requested_services JSONB NOT NULL DEFAULT '[]'::jsonb,
                        service_status     JSONB NOT NULL DEFAULT '{}'::jsonb,
                        status             TEXT NOT NULL DEFAULT 'new',
                        acknowledged_by    TEXT,
                        acknowledged_at    TIMESTAMPTZ,
                        closed_at          TIMESTAMPTZ,
                        responders         JSONB NOT NULL DEFAULT '[]'::jsonb,
                        photo_data_url     TEXT,
                        ai_assessment      JSONB,
                        idempotency_key    TEXT,
                        caller_profile     JSONB,
                        -- Concise AI-operator dispatch brief shown to responders
                        -- (the full conversation lives in operator_call_logs).
                        summary            TEXT
                    );
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_emergency_calls_created
                        ON emergency_calls (created_at DESC);
                """)
                cur.execute("""
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_emergency_calls_idem
                        ON emergency_calls (idempotency_key) WHERE idempotency_key IS NOT NULL;
                """)
                # Back-fill columns on tables created before they existed.
                cur.execute("ALTER TABLE emergency_calls ADD COLUMN IF NOT EXISTS caller_profile JSONB;")
                cur.execute("ALTER TABLE emergency_calls ADD COLUMN IF NOT EXISTS summary TEXT;")
                # Audit log of AI-operator conversations (caller chat + operator
                # replies + the final summary). One row per call session, upserted
                # as the call progresses so even abandoned calls are captured.
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS operator_call_logs (
                        session_id    TEXT PRIMARY KEY,
                        call_id       UUID,
                        citizen_id    TEXT,
                        citizen_name  TEXT,
                        started_at    TIMESTAMPTZ,
                        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        caller_lat    DOUBLE PRECISION,
                        caller_lng    DOUBLE PRECISION,
                        location_name TEXT,
                        conversation  JSONB NOT NULL DEFAULT '[]'::jsonb,
                        summary       TEXT,
                        services      JSONB,
                        severity      INTEGER,
                        category      TEXT,
                        ended         BOOLEAN NOT NULL DEFAULT FALSE
                    );
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_operator_logs_updated
                        ON operator_call_logs (updated_at DESC);
                """)
        conn.close()
        print("[schema] citizen_reports + responder_reports + emergency_calls ready.")
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


# Baseline weather: returned by /api/weather when no disaster is bending it,
# and used by /api/weather/regions as the ambient state outside any region.
BASELINE_WEATHER = {
    "icon": "☀️",
    "label": "Clear",
    "condition": "clear",
    "detail": "Calm and sunny across the metro.",
    "temperature_c": 22,
    "dew_point_c": 12,
    "wind_speed_kph": 8,
    "wind_direction_deg": 180,
    "precipitation_mm_per_hour": 0.0,
    "humidity_pct": 55,
    "pressure_hpa": 1015,
    "air_quality_aqi": 40,
    "visibility_km": 15.0,
    "alerts": [],
}


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _alert_severity(disaster_severity: int) -> str:
    if disaster_severity <= 2:
        return "minor"
    if disaster_severity <= 4:
        return "moderate"
    if disaster_severity <= 7:
        return "severe"
    return "extreme"


def _alert(event_id: Optional[str], kind: str, disaster_severity: int,
           headline: str, duration_minutes: int = 60) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    return {
        "id": f"{event_id or 'baseline'}:{kind}",
        "type": kind,
        "severity": _alert_severity(disaster_severity),
        "headline": headline,
        "start": now.isoformat(),
        "end": (now + timedelta(minutes=duration_minutes)).isoformat(),
    }


def _wildfire_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    # Temp climbs steeply with severity; humidity falls; AQI/visibility degrade.
    temp = _clamp(30 + severity * 3.5, 28, 60)
    aqi = int(_clamp(60 + severity * 45, 50, 500))
    alerts = [_alert(event_id, "air_quality", severity,
                     f"Smoke advisory — AQI {aqi} near active wildfire.")]
    if severity >= 3:
        alerts.append(_alert(event_id, "heat", severity,
                             f"Extreme heat from active wildfire ({int(temp)}°C)."))
    label = "Hot & Dry" if severity <= 2 else "Extreme Heat"
    icon = "☀️" if severity <= 2 else "🔥"
    return {
        "icon": icon, "label": label,
        "condition": "extreme_heat" if severity > 2 else "hot_dry",
        "detail": "Heatwave intensified by active wildfire."
                  if severity > 2 else "Dry heat, low humidity — fire weather.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(8 - severity * 0.8, -5, 12), 1),
        "wind_speed_kph": int(_clamp(12 + severity * 3, 5, 80)),
        "wind_direction_deg": 225,
        "precipitation_mm_per_hour": 0.0,
        "humidity_pct": int(_clamp(35 - severity * 3, 5, 90)),
        "pressure_hpa": int(_clamp(1010 - severity, 980, 1025)),
        "air_quality_aqi": aqi,
        "visibility_km": round(_clamp(15 - severity * 1.6, 0.3, 20), 1),
        "alerts": alerts,
    }


def _heatwave_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    severity = _clamp(severity, 1, 10)
    temp = _clamp(28 + severity * 2.5, 28, 55)
    aqi = int(_clamp(50 + severity * 10, 40, 350))
    alerts = [_alert(event_id, "heat", severity,
                     f"Heat advisory — {int(temp)}°C.")]
    if severity >= 3:
        alerts.append(_alert(event_id, "air_quality", severity,
                             f"Stagnant air — AQI {aqi}."))
    icon = "🥵" if severity >= 3 else "☀️"
    label = {1: "Warm", 2: "Hot", 3: "Severe Heat", 4: "Extreme Heat"}.get(
        severity, "Extreme Heat"
    )
    return {
        "icon": icon, "label": label,
        "condition": "extreme_heat" if severity >= 3 else ("hot" if severity == 2 else "warm"),
        "detail": f"{label} advisory — cooling centres on standby.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(14 + severity * 0.4, 8, 22), 1),
        "wind_speed_kph": int(_clamp(6 - severity * 0.3, 2, 12)),
        "wind_direction_deg": 180,
        "precipitation_mm_per_hour": 0.0,
        "humidity_pct": int(_clamp(35 + severity * 2, 20, 70)),
        "pressure_hpa": int(_clamp(1018 - severity, 1000, 1025)),
        "air_quality_aqi": aqi,
        "visibility_km": round(_clamp(15 - severity * 0.5, 5, 20), 1),
        "alerts": alerts,
    }


def _flood_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    # Storm-driven flood: heavy rain, falling temperature, severe winds.
    temp = _clamp(18 - severity * 1.2, 2, 20)
    precip = round(_clamp(severity * 8, 0, 120), 1)
    wind = int(_clamp(18 + severity * 4, 10, 110))
    alerts = [_alert(event_id, "flood", severity,
                     f"Flood advisory — {precip} mm/h rainfall.")]
    if severity >= 4:
        alerts.append(_alert(event_id, "severe_thunderstorm", severity,
                             f"Severe thunderstorm — wind {wind} kph."))
    if severity <= 2:
        icon, label, cond = "🌦️", "Light Rain", "light_rain"
        detail = "Light rain — minor street flooding."
    elif severity <= 4:
        icon, label, cond = "🌧️", "Heavy Rain", "heavy_rain"
        detail = "Sustained heavy rainfall."
    else:
        icon, label, cond = "⛈️", "Severe Storm", "severe_storm"
        detail = "Severe storm with flooding."
    return {
        "icon": icon, "label": label,
        "condition": cond, "detail": detail,
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(temp - 1.5, -2, 18), 1),
        "wind_speed_kph": wind,
        "wind_direction_deg": 90,
        "precipitation_mm_per_hour": precip,
        "humidity_pct": int(_clamp(80 + severity * 2, 70, 100)),
        "pressure_hpa": int(_clamp(1005 - severity, 970, 1015)),
        "air_quality_aqi": int(_clamp(35 - severity, 10, 60)),
        "visibility_km": round(_clamp(8 - severity * 0.7, 0.3, 12), 1),
        "alerts": alerts,
    }


def _infra_flood_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    # Infrastructure-driven flood (broken main, dam release, storm-drain
    # failure). No storm system, but standing water cools the air and pushes
    # humidity high. No rain, no wind to speak of.
    temp = _clamp(20 - severity * 0.6, 12, 22)
    alerts = [_alert(event_id, "flood", severity,
                     "Flood advisory — standing water from infrastructure failure.")]
    return {
        "icon": "💧", "label": "Humid & Cool",
        "condition": "humid_cool",
        "detail": "Standing water from a burst main / dam — humid and slightly cool.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(temp - 1, 10, 20), 1),
        "wind_speed_kph": 6,
        "wind_direction_deg": 180,
        "precipitation_mm_per_hour": 0.0,
        "humidity_pct": int(_clamp(75 + severity * 3, 70, 98)),
        "pressure_hpa": 1013,
        "air_quality_aqi": 38,
        "visibility_km": round(_clamp(12 - severity * 0.3, 8, 15), 1),
        "alerts": alerts,
    }


def _storm_outage_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    temp = _clamp(13 - severity * 0.4, 2, 18)
    wind = int(_clamp(40 + severity * 6, 35, 130))
    precip = round(_clamp(12 + severity * 3, 5, 80), 1)
    alerts = [_alert(event_id, "severe_thunderstorm", severity,
                     f"Severe storm — wind {wind} kph, {precip} mm/h.")]
    return {
        "icon": "⛈️", "label": "Severe Storm",
        "condition": "severe_storm",
        "detail": "Storm-related grid failure.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(temp - 1.0, -2, 16), 1),
        "wind_speed_kph": wind,
        "wind_direction_deg": 270,
        "precipitation_mm_per_hour": precip,
        "humidity_pct": int(_clamp(85 + severity, 70, 100)),
        "pressure_hpa": int(_clamp(995 - severity, 960, 1010)),
        "air_quality_aqi": 30,
        "visibility_km": round(_clamp(6 - severity * 0.4, 0.3, 10), 1),
        "alerts": alerts,
    }


def _freezing_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    temp = _clamp(-3 - severity * 1.5, -25, 2)
    alerts = [_alert(event_id, "freeze", severity,
                     f"Freeze warning — {int(temp)}°C, water-main risk.")]
    return {
        "icon": "❄️", "label": "Freezing",
        "condition": "freezing",
        "detail": "Freezing temperatures — water main rupture.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(temp - 3, 1),
        "wind_speed_kph": int(_clamp(12 + severity * 2, 5, 40)),
        "wind_direction_deg": 0,
        "precipitation_mm_per_hour": 0.0,
        "humidity_pct": int(_clamp(75 + severity, 60, 100)),
        "pressure_hpa": int(_clamp(1020 + severity, 1000, 1040)),
        "air_quality_aqi": 35,
        "visibility_km": round(_clamp(8 - severity * 0.5, 1, 12), 1),
        "alerts": alerts,
    }


def _building_fire_weather(severity: int, event_id: Optional[str]) -> Dict[str, Any]:
    # Local heat dome + smoke around an active structure fire.
    temp = _clamp(24 + severity * 4, 24, 70)
    aqi = int(_clamp(80 + severity * 50, 60, 500))
    alerts = [_alert(event_id, "air_quality", severity,
                     f"Structure-fire smoke — AQI {aqi}.")]
    if severity >= 3:
        alerts.append(_alert(event_id, "heat", severity,
                             f"Localised heat from active structure fire ({int(temp)}°C)."))
    return {
        "icon": "🔥", "label": "Structure Fire Heat",
        "condition": "extreme_heat",
        "detail": "Elevated temperatures and smoke from a structure fire.",
        "temperature_c": round(temp, 1),
        "dew_point_c": round(_clamp(10 - severity * 0.5, -2, 15), 1),
        "wind_speed_kph": int(_clamp(8 + severity * 1.5, 4, 30)),
        "wind_direction_deg": 200,
        "precipitation_mm_per_hour": 0.0,
        "humidity_pct": int(_clamp(40 - severity * 2, 15, 80)),
        "pressure_hpa": int(_clamp(1012 - severity, 990, 1020)),
        "air_quality_aqi": aqi,
        "visibility_km": round(_clamp(12 - severity * 1.2, 0.5, 15), 1),
        "alerts": alerts,
    }


def _weather_for_event(disaster_type: str, severity: int,
                       cause: Optional[str],
                       event_id: Optional[str] = None):
    """Return a full weather dict if this disaster bends the weather, else None.

    Severity is clamped to 1..10 by the disasters API, but we defensively clamp
    again so out-of-range inputs from older rows can't crash the field scalers.
    """
    if severity is None:
        return None
    severity = _clamp(int(severity), 1, 10)

    if disaster_type == "Wildfire":
        return _wildfire_weather(severity, event_id)

    if disaster_type == "Heatwave":
        return _heatwave_weather(severity, event_id)

    if disaster_type == "Building_Fire":
        return _building_fire_weather(severity, event_id)

    if disaster_type == "Flood":
        # Storm-driven floods get the full storm profile (rain, wind, falling
        # temp). Infrastructure-driven floods get a milder humid+cool profile.
        # Either way, every Flood produces a weather effect — flood without
        # weather impact is a UX dead end.
        if cause == "weather":
            return _flood_weather(severity, event_id)
        return _infra_flood_weather(severity, event_id)

    if disaster_type == "Power_Outage" and cause == "weather" and severity >= 3:
        return _storm_outage_weather(severity, event_id)

    if disaster_type == "Infrastructure_Failure" and cause == "weather" and severity == 1:
        return _freezing_weather(severity, event_id)

    return None


def _regional_weather(disaster_type: str, severity: int,
                      cause: Optional[str],
                      event_id: Optional[str] = None) -> Dict[str, Any]:
    """Always returns a full weather dict for a disaster's footprint.

    Falls back to a baseline-shaped snapshot for non-thermal events so the
    overlay still renders (and is therefore clickable) for things like
    Accident / Robbery / Road_Blockage — operators can still click the zone
    to see ambient conditions there.
    """
    weather = _weather_for_event(disaster_type, severity, cause, event_id)
    if weather is not None:
        return weather
    return {
        **BASELINE_WEATHER,
        "detail": f"No weather effect from {disaster_type.replace('_', ' ').lower()} — ambient conditions.",
        # Baseline alerts list is shared; copy so per-region edits don't leak.
        "alerts": [],
    }


# ── Geometry helpers for /api/weather/regions ─────────────────
# Just enough math to give the frontend a point + radius per region.
# Not GIS-accurate — disasters are small enough on a city scale that a
# flat-earth average of vertices is fine for overlay placement.

def _coerce_geojson(geometry):
    """psycopg2 returns JSONB as either dict or raw str depending on type
    registration. Normalise to dict (or None)."""
    if geometry is None:
        return None
    if isinstance(geometry, str):
        try:
            return json.loads(geometry)
        except (ValueError, TypeError):
            return None
    return geometry


def _geometry_centroid(geometry: Optional[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    """Returns {lat, lng} or None. Handles Point/Polygon/MultiPolygon/Feature."""
    geometry = _coerce_geojson(geometry)
    if not geometry:
        return None
    if geometry.get("type") == "Feature":
        geometry = geometry.get("geometry")
        if not geometry:
            return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None
    try:
        if gtype == "Point":
            lng, lat = coords[0], coords[1]
            return {"lat": float(lat), "lng": float(lng)}
        if gtype == "Polygon":
            ring = coords[0]
        elif gtype == "MultiPolygon":
            ring = coords[0][0]
        else:
            return None
        if not ring:
            return None
        lng = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        return {"lat": float(lat), "lng": float(lng)}
    except (TypeError, ValueError, IndexError):
        return None


def _geometry_radius_m(geometry: Optional[Dict[str, Any]],
                       centroid: Optional[Dict[str, float]]) -> Optional[float]:
    """Rough radius (metres) — farthest vertex from centroid. None for points/cities."""
    geometry = _coerce_geojson(geometry)
    if not geometry or not centroid:
        return None
    if geometry.get("type") == "Feature":
        geometry = geometry.get("geometry") or {}
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    rings = []
    if gtype == "Polygon":
        rings = coords
    elif gtype == "MultiPolygon":
        for poly in coords:
            rings.extend(poly)
    else:
        return None
    if not rings:
        return None
    # ~111_320 m per degree latitude; longitude varies with cos(lat).
    lat0 = math.radians(centroid["lat"])
    mx_per_deg_lng = 111_320 * math.cos(lat0)
    my_per_deg_lat = 110_540
    best = 0.0
    for ring in rings:
        for lng, lat in ring:
            dx = (lng - centroid["lng"]) * mx_per_deg_lng
            dy = (lat - centroid["lat"]) * my_per_deg_lat
            d = math.hypot(dx, dy)
            if d > best:
                best = d
    return round(best, 1) if best > 0 else None


class DisasterPayload(BaseModel):
    # Client-generated UUID. If omitted the server generates one.
    id: Optional[str] = None
    disaster_type: str = Field(..., examples=["Flood"])
    severity: int = Field(..., ge=1, le=10)
    # geometry is None for city-wide events (Heatwave, Power_Outage citywide).
    geometry: Optional[Dict[str, Any]] = None
    # 'point' | 'area' | 'city'. Optional for backward compatibility.
    geometry_kind: Optional[Literal["point", "area", "city"]] = None
    notes: Optional[str] = None
    # Discriminator consumed by /api/weather. Only meaningful for ambiguous
    # types (Flood / Power_Outage / Infrastructure_Failure). NULL is treated
    # as 'infrastructure' (no weather shift).
    cause: Optional[Literal["weather", "infrastructure"]] = None
    # 'draft' = visible to /api/weather but inert in the citizen sim.
    # 'active' = the disaster is live. Default keeps old clients working.
    status: Literal["draft", "active"] = "active"
    # Multiplier on the per-type spread rate from disasterProfiles.spreadRateMps.
    spread_speed: float = Field(1.0, ge=0.1, le=10.0)
    # Building_Fire fields. NULL for non-fire disasters.
    people_inside: Optional[int] = Field(None, ge=0)
    safe_exit_pct: Optional[float] = Field(None, ge=0, le=100)
    # Set when this fire spread from another. NULL = independent ignition.
    parent_id: Optional[str] = None
    # Building Fire delayed-spread timer (sim seconds). NULL = no scheduled
    # spread (i.e. children, if any, never auto-activate). Engine watches the
    # timer on the parent fire and asks the dashboard to PATCH children to
    # status='active' once it elapses, *unless* the parent has been extinguished.
    spread_in_seconds: Optional[int] = Field(None, ge=1, le=600)
    # 'ai' when written by the orchestrator's declare_incident tool, 'operator'
    # for dashboard writes. Used by /api/warnings/nearby to filter AI-only feeds.
    source: Optional[Literal["ai", "operator"]] = None


class FireStationPayload(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    lat: float
    lng: float
    truck_count: Optional[int] = Field(None, ge=0, le=50)


class HospitalPayload(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    lat: float
    lng: float
    ambulance_count: Optional[int] = Field(None, ge=0, le=50)


class PoliceStationPayload(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    lat: float
    lng: float
    police_count: Optional[int] = Field(None, ge=0, le=100)


class StationCountUpdate(BaseModel):
    # PATCH body to change a station's capacity cap.
    count: int = Field(..., ge=0, le=100)


class UnitAckPayload(BaseModel):
    # Body for dispatch_ack / return_ack. The station_id is in the URL path.
    units: int = Field(..., ge=1, le=50)


class DispatchPayload(BaseModel):
    # 'firefighter' is legacy; 'ambulance' / 'police' follow the same skeleton.
    kind: Literal["firefighter", "ambulance", "police"]
    # Generic count; 'trucks' is kept as a back-compat alias for firefighter.
    units: Optional[int] = Field(None, ge=1, le=50)
    trucks: Optional[int] = Field(None, ge=1, le=50)
    # {"lat": float, "lng": float, "radius": float?} — the dispatch search
    # area. `radius` (metres) is optional; when omitted the frontend engine
    # falls back to its default patrol radius.
    target: Dict[str, Any]
    # Optional station id the frontend picked. Useful for audit but not required.
    station_id: Optional[str] = None
    # Optional incident this dispatch responds to. Persisted on active_dispatches
    # so /api/warnings/nearby can correlate with the linked event.
    event_id: Optional[str] = None
    # 'ai' when the orchestrator (api_client.dispatch) issues this; 'operator'
    # for manual dashboard dispatches. Drives /api/warnings/nearby visibility.
    source: Optional[Literal["ai", "operator"]] = None


class NotificationPayload(BaseModel):
    geometry: Dict[str, Any]
    reason: str
    event_id: Optional[str] = None
    # 'ai' when emitted by the orchestrator's publish_citizen_alert tool;
    # 'operator' when drawn from the dashboard. See /api/warnings/nearby.
    source: Optional[Literal["ai", "operator"]] = None


class CordonPayload(BaseModel):
    geometry: Dict[str, Any]
    reason: Optional[str] = None
    event_id: Optional[str] = None
    source: Optional[Literal["ai", "operator"]] = None


class LoginPayload(BaseModel):
    device_id: str
    pin: str


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
def trigger_disaster(payload: DisasterPayload):
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

    event_id = payload.id or str(uuid.uuid4())

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO disaster_events
                        (id, disaster_type, severity, area_geometry, geometry_kind,
                         notes, status, cause, spread_speed,
                         people_inside, safe_exit_pct, parent_id, spread_in_seconds,
                         source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (
                        event_id,
                        payload.disaster_type,
                        payload.severity,
                        json.dumps(payload.geometry) if payload.geometry is not None else None,
                        payload.geometry_kind,
                        payload.notes,
                        payload.status,
                        payload.cause,
                        payload.spread_speed,
                        payload.people_inside,
                        payload.safe_exit_pct,
                        payload.parent_id,
                        payload.spread_in_seconds,
                        payload.source or "operator",
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

    # Mock CCTV cameras around the zone — AI agents will query the nearest
    # one for visual context when a citizen report comes in. Skips
    # Power_Outage (no images) and citywide events without geometry.
    cctv.spawn_cameras_for_zone(
        zone_id=str(returned_id),
        disaster_type=payload.disaster_type,
        severity=payload.severity,
        centroid=cctv.centroid_from_geometry(payload.geometry),
        geometry_kind=payload.geometry_kind,
    )

    return {
        "success": True,
        "message": "Emergency recorded. Sentinel units dispatched.",
        "event_id": str(returned_id),
    }


@app.post("/api/citizen-report", tags=["Citizen Reports"])
async def post_citizen_reports(
    batch: CitizenReportBatch,
    background_tasks: BackgroundTasks,
):
    """
    Batch-ingest 911 reports from the citizen simulation. Each report references
    an existing disaster_events.id; rows for unknown event_ids are dropped silently
    (the citizen sim may emit slightly stale references after a zone removal).

    Rows whose event_id isn't a syntactically valid UUID are also dropped
    silently — the engine emits synthetic ids like 'crime:<idx>:<t>' for
    operator-triggered robberies which aren't real disaster rows. Dropping them
    keeps the batch from failing on a Postgres UUID parse error.

    When SENTINEL_PIPELINE_MODE=new is set, each inserted report is scheduled
    onto a FastAPI BackgroundTask running pipeline.execute.process_report, which
    drives the single-pass NLU → cluster → decide → execute path. Otherwise the
    legacy wake_bus path runs.
    """
    if not batch.reports:
        return {"inserted": 0}

    rows = []
    skipped = 0
    for r in batch.reports:
        try:
            uuid.UUID(str(r.event_id))
        except (ValueError, AttributeError, TypeError):
            skipped += 1
            continue
        rows.append((
            str(uuid.uuid4()),
            r.event_id,
            r.citizen_idx,
            r.report_kind,
            json.dumps(r.location),
            r.transcript,
            r.perceived_severity,
        ))
    inserted = 0
    inserted_ids: list[str] = []
    if rows:
        try:
            conn = psycopg2.connect(DATABASE_URL)
            with conn:
                with conn.cursor() as cur:
                    inserted_ids = [
                        str(row[0]) for row in psycopg2.extras.execute_values(
                            cur,
                            """
                            INSERT INTO citizen_reports
                                (id, event_id, citizen_idx, report_kind, location, transcript, perceived_severity)
                            VALUES %s
                            ON CONFLICT DO NOTHING
                            RETURNING id;
                            """,
                            rows,
                            fetch=True,
                        )
                    ]
                    inserted = len(inserted_ids)
            conn.close()
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Citizen report write failed: {exc}",
            )

    # Pipeline trigger: schedule one BackgroundTask per inserted row. The
    # mobile/web client gets a 200 OK immediately; the LLM extraction +
    # clustering + dispatch happen out-of-band. This is the only AI entry
    # point — there is no polling loop, no heartbeat.
    if inserted_ids:
        try:
            from pipeline.execute import process_report as _pipeline_process
            for rid in inserted_ids:
                background_tasks.add_task(_pipeline_process, rid)
        except Exception as exc:
            # Never block the ingest if the pipeline import fails; the row is
            # already persisted and can be retried.
            logging.getLogger(__name__).warning(
                f"pipeline trigger failed: {exc}"
            )

    return {"inserted": inserted, "skipped": skipped}


@app.get("/api/citizen-reports", tags=["Citizen Reports"])
def get_citizen_reports(
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


@app.get("/api/reported-event-ids", tags=["Citizen Reports"])
def get_reported_event_ids():
    """Just the distinct disaster/event ids that have at least one citizen report.
    The mobile app uses this to decide which disasters to surface (a zone only
    appears once citizens report it) WITHOUT downloading the full ~118 KB reports
    feed every few seconds. Tiny payload, index-backed (idx_citizen_reports_event)."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT event_id FROM citizen_reports WHERE event_id IS NOT NULL;")
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Reported-event-id read failed: {exc}",
        )
    return {"event_ids": [str(r[0]) for r in rows]}


# ─── Responder field reports (casualty + fire_sighted) ──────────────────

_RESPONDER_REPORT_KINDS = {
    "casualty_injured", "casualty_fainted", "casualty_critical", "fire_sighted",
}


class ResponderReport(BaseModel):
    event_id: Optional[str] = None
    responder_unit_id: str = Field(..., min_length=1)
    report_kind: Literal[
        "casualty_injured", "casualty_fainted", "casualty_critical", "fire_sighted"
    ]
    location: Dict[str, float]
    severity: Optional[int] = None
    is_correction: bool = False
    notes: Optional[str] = None


class ResponderReportBatch(BaseModel):
    reports: List[ResponderReport]


def _nearest_resource(
    target_lat: float,
    target_lng: float,
    kind: str,
    *,
    required_capacity: int = 1,
) -> Optional[Dict[str, Any]]:
    """Return the nearest hospital / fire_station / police_station to (lat,lng)
    that has at least `required_capacity` available units.

    Used by:
      - Server-side auto-dispatch on casualty reports (instant ambulance routing)
      - The orchestrator's monitoring context (precomputed nearest-station hints
        so the AI doesn't have to do haversine in its head)

    Pure server-side: reads from Postgres, ranks in Python. The station tables
    are small (<= ~20 rows in demo) so an O(N) sort is fine.
    """
    table_meta = {
        "hospital":       ("hospitals",       "ambulance_count", "ambulances_dispatched"),
        "fire_station":   ("fire_stations",   "truck_count",     "trucks_dispatched"),
        "police_station": ("police_stations", "police_count",    "police_dispatched"),
    }.get(kind)
    if table_meta is None:
        return None
    table, cap_col, dispatched_col = table_meta

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT id, name, lat, lng, {cap_col}, {dispatched_col} FROM {table};"
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        logging.getLogger("sentinel.nearest").warning(
            f"_nearest_resource read failed for {kind}: {exc}"
        )
        return None

    ranked = []
    for rid, name, lat, lng, cap, dispatched in rows:
        try:
            available = int(cap or 0) - int(dispatched or 0)
        except (TypeError, ValueError):
            available = 0
        if available < required_capacity:
            continue
        d = _distance_haversine(target_lat, target_lng, float(lat), float(lng))
        ranked.append({
            "id": str(rid),
            "name": name,
            "lat": float(lat),
            "lng": float(lng),
            "available": available,
            "distance_m": round(d, 1),
        })
    ranked.sort(key=lambda r: r["distance_m"])
    return ranked[0] if ranked else None


def _nearest_resources(
    target_lat: float,
    target_lng: float,
    kind: str,
    *,
    limit: int = 5,
) -> List[Dict[str, Any]]:
    """Top-N nearest resources by distance, including those at capacity (so the
    AI can see them and reason). Used to populate the monitoring context."""
    table_meta = {
        "hospital":       ("hospitals",       "ambulance_count", "ambulances_dispatched"),
        "fire_station":   ("fire_stations",   "truck_count",     "trucks_dispatched"),
        "police_station": ("police_stations", "police_count",    "police_dispatched"),
    }.get(kind)
    if table_meta is None:
        return []
    table, cap_col, dispatched_col = table_meta
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT id, name, lat, lng, {cap_col}, {dispatched_col} FROM {table};"
                )
                rows = cur.fetchall()
        conn.close()
    except Exception:
        return []
    out = []
    for rid, name, lat, lng, cap, dispatched in rows:
        try:
            available = max(0, int(cap or 0) - int(dispatched or 0))
        except (TypeError, ValueError):
            available = 0
        d = _distance_haversine(target_lat, target_lng, float(lat), float(lng))
        out.append({
            "id": str(rid),
            "name": name,
            "available": available,
            "distance_m": round(d, 1),
        })
    out.sort(key=lambda r: r["distance_m"])
    return out[:limit]


def _enqueue_pending_dispatch(*, kind: str, units: int, target: Dict[str, float], station_id: str) -> str:
    """Add a dispatch to PENDING_DISPATCHES for the frontend engine to consume.
    Returns the dispatch_id. Mirrors the /api/dispatch endpoint's side effect
    so we can fire dispatches from server-side code without going through HTTP."""
    dispatch_id = str(uuid.uuid4())
    PENDING_DISPATCHES.append({
        "dispatch_id": dispatch_id,
        "kind": kind,
        "units": units,
        "target": dict(target),
        "station_id": station_id,
    })
    return dispatch_id


@app.post("/api/responder-report", tags=["Responder Reports"])
async def post_responder_reports(batch: ResponderReportBatch):
    """Batch-ingest responder field reports (casualty detections + fire-sighted
    corrections). Each report carries PRECISE GPS — no triangulation needed.

    Side effects beyond persistence:
      - For any report with `is_correction=true` (fire_sighted), updates the
        referenced disaster's `location_estimate` column so the AI's next
        wake sees the corrected coordinates.
      - Pushes one WakeBus event per distinct `report_kind` (area-deduped)
        so the monitoring loop wakes within DEBOUNCE_SECONDS.
    """
    if not batch.reports:
        return {"inserted": 0}

    rows = []
    skipped = 0
    correction_updates: List[Tuple[str, Dict[str, float]]] = []
    for r in batch.reports:
        try:
            ev_uuid = None
            if r.event_id:
                # The casualty path always carries an event_id; fire_sighted
                # corrections do too. Drop rows with non-UUID event_ids
                # silently — synthetic ids from operator-triggered events
                # (crime:idx:t) shouldn't reach this endpoint, but be safe.
                ev_uuid = str(uuid.UUID(str(r.event_id)))
        except (ValueError, AttributeError, TypeError):
            skipped += 1
            continue
        rows.append((
            str(uuid.uuid4()),
            ev_uuid,
            r.responder_unit_id,
            r.report_kind,
            json.dumps(r.location),
            r.severity,
            bool(r.is_correction),
            r.notes,
        ))
        if r.is_correction and r.report_kind == "fire_sighted" and ev_uuid:
            correction_updates.append((ev_uuid, r.location))

    if not rows:
        return {"inserted": 0, "skipped": skipped}

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO responder_reports
                        (id, event_id, responder_unit_id, report_kind,
                         location, severity, is_correction, notes)
                    VALUES %s;
                    """,
                    rows,
                )
                inserted = cur.rowcount
                # Apply correction location_estimate updates inside the same tx
                for ev_id, loc in correction_updates:
                    cur.execute(
                        """
                        UPDATE disaster_events
                        SET location_estimate = %s
                        WHERE id = %s;
                        """,
                        (json.dumps(loc), ev_id),
                    )
                # fire_sighted:correction reports self-resolve — the correction
                # itself IS the action; the AI just needs to be informed.
                cur.execute(
                    """
                    UPDATE responder_reports
                    SET status = 'resolved', resolved_at = NOW()
                    WHERE report_kind = 'fire_sighted' AND is_correction = TRUE
                      AND status = 'pending';
                    """
                )
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Responder report write failed: {exc}",
        )

    # ── Server-side ambulance auto-dispatch (time-critical) ───────────────
    # Bug observed: AI-mediated ambulance dispatch was arriving AFTER casualties
    # had died (wake-bus debounce + LLM latency + ReAct cycles ≈ 30-90 seconds).
    # Casualty reports are unambiguous: 1 ambulance to the precise GPS from the
    # nearest hospital with capacity. No AI judgment needed. Fire-and-forget.
    auto_dispatched = 0
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                for r in batch.reports:
                    if not r.report_kind.startswith("casualty_"):
                        continue
                    try:
                        lat = float(r.location.get("lat"))
                        lng = float(r.location.get("lng"))
                    except (TypeError, ValueError, AttributeError):
                        continue
                    if abs(lat) < 0.001 and abs(lng) < 0.001:
                        continue
                    nearest = _nearest_resource(lat, lng, "hospital", required_capacity=1)
                    if nearest is None:
                        logging.getLogger("sentinel.auto_dispatch").warning(
                            f"No hospital with available ambulance capacity for casualty "
                            f"at ({lat:.5f},{lng:.5f}) — leaving pending for AI"
                        )
                        continue
                    dispatch_id = _enqueue_pending_dispatch(
                        kind="ambulance",
                        units=1,
                        target={"lat": lat, "lng": lng},
                        station_id=nearest["id"],
                    )
                    # Mark the report resolved so the AI doesn't re-dispatch.
                    cur.execute(
                        """
                        UPDATE responder_reports
                        SET status = 'resolved',
                            resolved_at = NOW(),
                            notes = COALESCE(notes, '') ||
                                    ' [auto-dispatched ambulance from ' || %s ||
                                    ' (' || %s || 'm)]'
                        WHERE event_id = %s
                          AND status = 'pending'
                          AND report_kind = %s
                          AND (location->>'lat')::float = %s
                          AND (location->>'lng')::float = %s;
                        """,
                        (
                            str(nearest.get("name") or nearest["id"]),
                            int(nearest["distance_m"]),
                            r.event_id,
                            r.report_kind,
                            lat,
                            lng,
                        ),
                    )
                    auto_dispatched += 1
        conn.close()
    except Exception as exc:
        logging.getLogger("sentinel.auto_dispatch").warning(
            f"casualty auto-dispatch best-effort path failed: {exc}"
        )

    return {
        "inserted": inserted,
        "skipped": skipped,
        "auto_dispatched_ambulances": auto_dispatched,
    }


@app.get("/api/responder-reports", tags=["Responder Reports"])
def get_responder_reports(
    status_filter: Optional[Literal["pending", "resolved"]] = Query(
        "pending", alias="status",
        description="Filter by report status. Defaults to 'pending' (the AI's working set).",
    ),
    since: Optional[datetime] = Query(None, description="Return reports newer than this timestamp."),
    limit: int = Query(200, ge=1, le=1000),
):
    """Read recent responder reports — primary consumer is the AI orchestrator
    (monitoring loop). Defaults to status=pending so the agent's context only
    surfaces work that still needs an ambulance / acknowledgement."""
    clauses = []
    params: List[Any] = []
    if status_filter is not None:
        clauses.append("status = %s")
        params.append(status_filter)
    if since is not None:
        clauses.append("reported_at > %s")
        params.append(since)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, event_id, responder_unit_id, report_kind,
                           location, severity, is_correction, notes,
                           status, reported_at, resolved_at
                    FROM responder_reports
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
            detail=f"Responder report read failed: {exc}",
        )

    return {
        "reports": [
            {
                "id": str(r[0]),
                "event_id": str(r[1]) if r[1] else None,
                "responder_unit_id": r[2],
                "report_kind": r[3],
                "location": r[4],
                "severity": r[5],
                "is_correction": r[6],
                "notes": r[7],
                "status": r[8],
                "reported_at": r[9].isoformat(),
                "resolved_at": r[10].isoformat() if r[10] else None,
            }
            for r in rows
        ]
    }


@app.get("/api/nearest-resources", tags=["Emergency Services"])
def get_nearest_resources(
    lat: float = Query(...),
    lng: float = Query(...),
    kind: Literal["hospital", "fire_station", "police_station"] = Query(...),
    limit: int = Query(3, ge=1, le=20),
):
    """Server-side nearest-resource ranking by haversine distance.

    The AI monitoring loop calls this once per active incident to get a
    pre-ranked list of stations, so it doesn't have to do geographic math
    itself (LLMs are notoriously bad at that). Counts ambulances /
    trucks / officers and excludes none — at-capacity stations are still
    listed so the AI sees them but can prefer one with `available > 0`.
    """
    return {"resources": _nearest_resources(lat, lng, kind, limit=limit)}


@app.post("/api/responder-reports/resolve-near", tags=["Responder Reports"])
def resolve_responder_reports_near(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_m: float = Query(100, ge=10, le=2000),
    report_kind_prefix: str = Query("casualty_", description="Only resolve reports whose kind starts with this prefix"),
):
    """Mark pending responder reports within `radius_m` of (lat, lng) as resolved.

    Called by agent_tools._track_sla_event after a successful ambulance dispatch,
    so the AI doesn't re-see the same casualty on its next monitoring tick.
    Uses haversine; not perfectly indexable but the pending working set is small.
    """
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # Pull pending rows of the requested kind. The set is tiny in
                # practice (few dozen at peak) so a Python-side filter is fine.
                cur.execute(
                    """
                    SELECT id, location FROM responder_reports
                    WHERE status = 'pending' AND report_kind LIKE %s
                    """,
                    (report_kind_prefix + "%",),
                )
                candidates = cur.fetchall()
                to_resolve: List[str] = []
                for row_id, loc in candidates:
                    try:
                        rlat = float(loc.get("lat"))
                        rlng = float(loc.get("lng"))
                    except (TypeError, ValueError, AttributeError):
                        continue
                    if _distance_haversine(lat, lng, rlat, rlng) <= radius_m:
                        to_resolve.append(str(row_id))
                if to_resolve:
                    cur.execute(
                        """
                        UPDATE responder_reports
                        SET status = 'resolved', resolved_at = NOW()
                        WHERE id = ANY(%s::uuid[]);
                        """,
                        (to_resolve,),
                    )
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Responder report resolve failed: {exc}",
        )

    return {"resolved": len(to_resolve)}


# Cache the detected geometry-column SQL expression for the lifetime of the
# process. The schema doesn't change on the fly, so a single probe is enough.
_GEOM_EXPR: Optional[str] = None


def _geometry_select_expr(cur) -> str:
    """SQL expression that yields area_geometry as a GeoJSON string. The
    deployed Supabase schema stores it as PostGIS geometry (despite init.sql
    declaring JSONB), so we wrap in ST_AsGeoJSON when needed."""
    global _GEOM_EXPR
    if _GEOM_EXPR is not None:
        return _GEOM_EXPR
    cur.execute(
        """
        SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'disaster_events'
          AND column_name = 'area_geometry';
        """
    )
    udt = cur.fetchone()
    _GEOM_EXPR = (
        "ST_AsGeoJSON(area_geometry)" if udt and udt[0] == "geometry" else "area_geometry"
    )
    return _GEOM_EXPR


def _fetch_weather_driving_events():
    """Returns rows (id, disaster_type, severity, cause, area_geometry, geometry_kind)
    for events that influence weather, severity-desc then recency."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                geom_expr = _geometry_select_expr(cur)
                cur.execute(
                    f"""
                    SELECT id, disaster_type, severity, cause,
                           {geom_expr}, geometry_kind
                    FROM disaster_events
                    WHERE status IN ('draft', 'active')
                    ORDER BY severity DESC, created_at DESC;
                    """
                )
                return cur.fetchall()
    finally:
        conn.close()


@app.get("/api/weather", tags=["Weather"])
def get_weather():
    """
    Global weather summary derived from active disasters.

    Returns the worst-case weather across all active disaster events (the first
    that bends the weather in severity-desc order). Use /api/weather/regions
    for the full per-region breakdown.
    """
    try:
        rows = _fetch_weather_driving_events()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Weather read failed: {exc}",
        )

    for event_id, disaster_type, severity, cause, _geom, _gkind in rows:
        weather = _weather_for_event(disaster_type, severity, cause, str(event_id))
        if weather is not None:
            return {
                **weather,
                "driver": {
                    "event_id": str(event_id),
                    "disaster_type": disaster_type,
                    "severity": severity,
                    "cause": cause,
                },
            }

    return {**BASELINE_WEATHER, "driver": None}


def _distance_haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    R = 6371000  # radius of Earth in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


@app.get("/api/traffic", tags=["Traffic"])
def get_traffic():
    """
    Mocked traffic snapshot derived from active disasters and cordons.
    - Segments near active disasters: flow stopped / severely congested
    - Segments within/near active cordons: blocked / rerouted
    - Baseline: normal Manhattan flow
    """
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # Get active disasters with geometry
                cur.execute(
                    """
                    SELECT id, disaster_type, area_geometry
                    FROM disaster_events
                    WHERE status IN ('draft', 'active') AND area_geometry IS NOT NULL;
                    """
                )
                active_disasters = cur.fetchall()

                # Get active cordons
                cur.execute(
                    """
                    SELECT id, reason, geometry
                    FROM cordons
                    WHERE status = 'active';
                    """
                )
                active_cordons = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Traffic read failed: {exc}",
        )

    # Mock road segments (a small sample for the demo)
    segments = [
        {"id": "seg_001", "name": "W 42nd St & 7th Ave", "lat": 40.7565, "lng": -73.9870},
        {"id": "seg_002", "name": "E 14th St & Broadway", "lat": 40.7348, "lng": -73.9908},
        {"id": "seg_003", "name": "5th Ave & 59th St", "lat": 40.7645, "lng": -73.9733},
        {"id": "seg_004", "name": "Canal St & Bowery", "lat": 40.7159, "lng": -73.9961},
        {"id": "seg_005", "name": "125th St & Lexington", "lat": 40.8043, "lng": -73.9372},
        {"id": "seg_006", "name": "Houston St & 1st Ave", "lat": 40.7231, "lng": -73.9881},
        {"id": "seg_007", "name": "23rd St & 8th Ave", "lat": 40.7445, "lng": -73.9994},
        {"id": "seg_008", "name": "86th St & 2nd Ave", "lat": 40.7776, "lng": -73.9515},
    ]

    traffic_response = []
    
    for seg in segments:
        slat = seg["lat"]
        slng = seg["lng"]
        
        # Default state
        speed = 30
        congestion = 0.2
        incident = None
        
        # Check cordons first (blocks road completely)
        for cid, reason, geom in active_cordons:
            if not geom: continue
            try:
                geom_dict = geom if isinstance(geom, dict) else json.loads(geom)
                if geom_dict.get("type") == "Polygon" and len(geom_dict.get("coordinates", [])) > 0:
                    # Simple bounding box check for the mock
                    coords = geom_dict["coordinates"][0]
                    lats = [c[1] for c in coords]
                    lngs = [c[0] for c in coords]
                    if min(lats) <= slat <= max(lats) and min(lngs) <= slng <= max(lngs):
                        speed = 0
                        congestion = 1.0
                        incident = f"Road blocked by cordon: {reason or 'No entry'}"
                        break
            except Exception:
                pass
                
        # If not fully blocked by cordon, check disasters
        if incident is None:
            for did, dtype, geom in active_disasters:
                if not geom: continue
                try:
                    geom_dict = geom if isinstance(geom, dict) else json.loads(geom)
                    if geom_dict.get("type") == "Polygon" and len(geom_dict.get("coordinates", [])) > 0:
                        coords = geom_dict["coordinates"][0]
                        # Use first point as approximate center for distance
                        clat = coords[0][1]
                        clng = coords[0][0]
                        dist = _distance_haversine(slat, slng, clat, clng)
                        
                        if dist < 150: # Inside or very close
                            speed = 5
                            congestion = 0.9
                            incident = f"{dtype} active — severe congestion"
                            break
                        elif dist < 400: # Adjacent
                            speed = 15
                            congestion = 0.6
                            incident = f"Slow traffic due to nearby {dtype}"
                except Exception:
                    pass

        traffic_response.append({
            "segment_id": seg["id"],
            "name": seg["name"],
            "lat": slat,
            "lng": slng,
            "current_speed_kph": speed,
            "free_flow_speed_kph": 35,
            "congestion_pct": congestion,
            "confidence": 0.85,
            "incident": incident
        })

    return {
        "segments": traffic_response,
        "updated_at": datetime.utcnow().isoformat() + "Z"
    }


@app.get("/api/weather/regions", tags=["Weather"])
def get_weather_regions():
    """
    Per-region weather. Each weather-bending active disaster produces one
    region; the response also carries the ambient baseline applied everywhere
    outside those regions.

    A region with no geometry (citywide events like Heatwave / citywide
    Power_Outage) sets `scope: "city"` and is meant to override the baseline
    globally on the client.
    """
    try:
        rows = _fetch_weather_driving_events()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Weather read failed: {exc}",
        )

    regions: List[Dict[str, Any]] = []
    citywide_override: Optional[Dict[str, Any]] = None

    for event_id, disaster_type, severity, cause, geom, gkind in rows:
        weather = _regional_weather(disaster_type, severity, cause, str(event_id))
        # `_weather_for_event` is what tells us whether this disaster actually
        # bends the weather (only the bending ones can override the global
        # chip when they're citywide).
        bends_weather = _weather_for_event(disaster_type, severity, cause, str(event_id)) is not None

        geom = _coerce_geojson(geom)
        if gkind == "city" or geom is None:
            scope = "city"
        else:
            # Trust the geometry's actual type — geometry_kind in the DB has
            # been observed to disagree (Point stored with kind='area').
            geom_type = geom.get("type") if isinstance(geom, dict) else None
            scope = "point" if geom_type == "Point" else "area"

        # Citywide events that DON'T bend weather (e.g. citywide Power_Outage
        # with cause='infrastructure') would otherwise return baseline-shaped
        # snapshots and clutter the response without affecting anything. Skip.
        if scope == "city" and not bends_weather:
            continue

        centroid = _geometry_centroid(geom)
        radius_m = _geometry_radius_m(geom, centroid)

        region = {
            "event_id": str(event_id),
            "disaster_type": disaster_type,
            "severity": severity,
            "cause": cause,
            "scope": scope,
            "geometry": geom,
            "geometry_kind": gkind,
            "centroid": centroid,
            "radius_m": radius_m,
            "bends_weather": bends_weather,
            "weather": weather,
        }
        regions.append(region)

        # Remember the most-severe citywide region as the global override
        # (only bending citywide events get this — non-bending ones were
        # already filtered out above).
        if scope == "city" and citywide_override is None:
            citywide_override = region

    baseline = {**BASELINE_WEATHER}
    global_weather = citywide_override["weather"] if citywide_override else baseline

    return {
        "baseline": baseline,
        "global": {
            **global_weather,
            "driver": (
                {
                    "event_id": citywide_override["event_id"],
                    "disaster_type": citywide_override["disaster_type"],
                    "severity": citywide_override["severity"],
                    "cause": citywide_override["cause"],
                }
                if citywide_override
                else None
            ),
        },
        "regions": regions,
    }


@app.patch("/api/disasters/{event_id}", tags=["Disasters"])
def update_disaster(event_id: str, update: Dict[str, Any]):
    """Partial update of a disaster_events row. Used to flip draft → active, or update polygon."""
    allowed = {"status", "spread_speed", "notes", "people_inside", "safe_exit_pct", "spread_in_seconds", "severity", "area_geometry"}
    sets = {}
    for k, v in update.items():
        if k in allowed:
            if k == "area_geometry":
                sets[k] = json.dumps(v) if v is not None else None
            else:
                sets[k] = v

    if not sets:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No mutable fields supplied.",
        )
    cols = ", ".join(f"{k} = %s" for k in sets)
    values = list(sets.values()) + [event_id]
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE disaster_events SET {cols} WHERE id = %s RETURNING id;",
                    tuple(values),
                )
                if cur.fetchone() is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Disaster not found.",
                    )
        conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Update failed: {exc}",
        )
    return {"success": True}


@app.delete("/api/disasters", tags=["Disasters"])
def delete_all_disasters():
    """Wipe every row in disaster_events. Used by the "Clear all zones"
    operator action to reset simulator state."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM disaster_events;")
                deleted = cur.rowcount
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Bulk delete failed: {exc}",
        )
    cctv.clear_all_cameras()
    return {"success": True, "deleted": deleted}


@app.delete("/api/disasters/{event_id}", tags=["Disasters"])
def delete_disaster(event_id: str):
    """Resolve an incident: close any cordons + dispatches tied to it, then
    delete the disaster row. Called by the operator dashboard's
    onZoneResolved hook when firefighters extinguish a fire (the wave radius
    hits zero and the engine signals resolution).
    """
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # 1. Close any cordons raised for this incident so they
                #    don't linger on the map after the fire is out.
                cur.execute(
                    "UPDATE cordons SET status = 'cleared' "
                    "WHERE event_id = %s::uuid AND status = 'active';",
                    (event_id,),
                )
                # 2. Mark outstanding active_dispatches done. The truck
                #    engine recalls trucks via its own onZoneResolved path
                #    (and posts return_ack to decrement station counters);
                #    this row update keeps /api/warnings/nearby honest for
                #    mobile clients still pointing at the row.
                cur.execute(
                    "UPDATE active_dispatches SET status = 'completed' "
                    "WHERE event_id = %s::uuid AND status = 'active';",
                    (event_id,),
                )
                # 3. Remove the disaster.
                cur.execute("DELETE FROM disaster_events WHERE id = %s;", (event_id,))
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Delete failed: {exc}",
        )
    cctv.clear_cameras_for_zone(event_id)
    return {"success": True}


def _row_to_disaster(row) -> Dict[str, Any]:
    # area_geometry comes back either as raw JSONB (dict) or a GeoJSON-string
    # (from ST_AsGeoJSON on PostGIS geometry columns). Normalise to dict here
    # so every consumer — web dashboard, mobile WebView, /api/weather/regions —
    # gets a parseable GeoJSON object.
    return {
        "id": str(row[0]),
        "disaster_type": row[1],
        "severity": row[2],
        "area_geometry": _coerce_geojson(row[3]),
        "geometry_kind": row[4],
        "notes": row[5],
        "status": row[6],
        "cause": row[7],
        "spread_speed": row[8],
        "people_inside": row[9],
        "safe_exit_pct": row[10],
        "created_at": row[11].isoformat() if row[11] is not None else None,
        # Set by the fire_sighted correction path. None when no responder has
        # ever corrected the location. The orchestrator pulls this into
        # IncidentState.location_estimate so the AI sees the corrected coords.
        "location_estimate": row[12] if len(row) > 12 else None,
        "source": (row[13] if len(row) > 13 else None) or "operator",
    }


@app.get("/api/disasters", tags=["Disasters"])
def list_disasters(status_filter: Optional[str] = Query(None, description="active|draft|cleared|all")):
    where = ""
    params: List[Any] = []
    if status_filter and status_filter != "all":
        where = "WHERE status = %s"
        params.append(status_filter)
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                geom_expr = _geometry_select_expr(cur)
                cur.execute(
                    f"""
                    SELECT id, disaster_type, severity, {geom_expr}, geometry_kind,
                           notes, status, cause, spread_speed, people_inside,
                           safe_exit_pct, created_at, location_estimate, source
                    FROM disaster_events
                    {where}
                    ORDER BY created_at DESC;
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Disaster read failed: {exc}",
        )
    return {"disasters": [_row_to_disaster(r) for r in rows]}


@app.get("/api/disasters/{event_id}", tags=["Disasters"])
def get_disaster(event_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                geom_expr = _geometry_select_expr(cur)
                cur.execute(
                    f"""
                    SELECT id, disaster_type, severity, {geom_expr}, geometry_kind,
                           notes, status, cause, spread_speed, people_inside,
                           safe_exit_pct, created_at, location_estimate, source
                    FROM disaster_events
                    WHERE id = %s;
                    """,
                    (event_id,),
                )
                row = cur.fetchone()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Disaster read failed: {exc}",
        )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Disaster not found.")
    return _row_to_disaster(row)


# ──────────────────────────────────────────────────────────────────────
# Mock CCTV cameras. Spawned around every triggered zone (except
# Power_Outage). Lifecycle is bound to the zone — cameras vanish when the
# zone is deleted (DELETE /api/disasters/{id}) or cleared.
# ──────────────────────────────────────────────────────────────────────


@app.get("/api/cctv/cameras", tags=["CCTV"])
def list_cctv_cameras(zone_id: Optional[str] = Query(None)):
    """Return every live mock camera, optionally filtered by zone_id.
    The frontend MockCameraLayer polls this after every trigger / resolve."""
    return {"cameras": cctv.list_cameras(zone_id=zone_id)}


@app.get("/api/cctv/feed/{camera_id}", tags=["CCTV"])
def get_cctv_feed(camera_id: str):
    """Stream the pre-generated CCTV image bound to this camera's
    (disaster_type, severity). Used by the operator UI popup and by the
    Gemini multimodal call (which reads the file directly via cctv.resolve_image
    rather than round-tripping through HTTP)."""
    from fastapi.responses import FileResponse

    cam = cctv.get_camera(camera_id)
    if cam is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found.")
    path = cctv.resolve_image(cam["disaster_type"], cam["severity"])
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No CCTV feed available for this disaster type / severity.",
        )
    return FileResponse(path, media_type=cctv.image_mimetype(path))


# ──────────────────────────────────────────────────────────────────────
# /api/warnings/nearby — AI-only nearby warning feed for the mobile app.
#
# Aggregates five spatially-filtered AI sources into one ordered list:
#   1. notifications  (publish_citizen_alert tool)
#   2. cordons        (create_cordon tool)
#   3. disaster_events(declare_incident tool)
#   4. active_dispatches (ai-issued dispatches with target + radius)
#   5. weather alerts (synthesised from regions that overlap the user buffer)
#
# All entries are stamped source='ai' (set via api_client). Operator-drawn
# rows from the dashboard never appear here. Proximity is a conservative
# buffer test using existing centroid + radius helpers — over-include rather
# than miss.
# ──────────────────────────────────────────────────────────────────────

_COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"]


def _compass_bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> str:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dl)
    deg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return _COMPASS_POINTS[int((deg + 22.5) // 45)]


def _service_label(kind: str) -> str:
    return {
        "firefighter": "Fire response",
        "ambulance": "Medical response",
        "police": "Police response",
    }.get(kind, "Emergency response")


@app.get("/api/warnings/nearby", tags=["Mobile"])
def warnings_nearby(
    lat: Optional[float] = Query(None, description="User latitude — omit for citywide (admin) feed"),
    lng: Optional[float] = Query(None, description="User longitude — omit for citywide (admin) feed"),
    radius_m: float = Query(5000.0, gt=0, le=50000, description="Search radius in metres"),
):
    # Admin / citywide callers omit lat+lng and get every active AI warning,
    # unfiltered by distance. distance_m and bearing default to placeholders.
    citywide = lat is None or lng is None
    if citywide:
        lat = 0.0
        lng = 0.0
    out: List[Dict[str, Any]] = []

    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # 1. AI notifications (citizen alerts)
                cur.execute(
                    """
                    SELECT id, geometry, reason, event_id, created_at
                    FROM notifications
                    WHERE status = 'active' AND source = 'ai'
                    ORDER BY created_at DESC;
                    """
                )
                for r in cur.fetchall():
                    geom = _coerce_geojson(r[1])
                    centroid = _geometry_centroid(geom)
                    if centroid is None:
                        continue
                    d = _distance_haversine(lat, lng, centroid["lat"], centroid["lng"])
                    buffer_m = (_geometry_radius_m(geom, centroid) or 0.0) + radius_m
                    if not citywide and d > buffer_m:
                        continue
                    out.append({
                        "id": f"notif:{r[0]}",
                        "kind": "alert",
                        "severity": 3,
                        "title": "Citizen alert",
                        "message": r[2],
                        "geometry": geom,
                        "distance_m": round(d, 0),
                        "bearing": _compass_bearing(lat, lng, centroid["lat"], centroid["lng"]),
                        "event_id": str(r[3]) if r[3] is not None else None,
                        "source": "ai",
                        "created_at": r[4].isoformat(),
                    })

                # 2. AI cordons (no-entry zones)
                cur.execute(
                    """
                    SELECT id, geometry, reason, event_id, created_at
                    FROM cordons
                    WHERE status = 'active' AND source = 'ai'
                    ORDER BY created_at DESC;
                    """
                )
                for r in cur.fetchall():
                    geom = _coerce_geojson(r[1])
                    centroid = _geometry_centroid(geom)
                    if centroid is None:
                        continue
                    d = _distance_haversine(lat, lng, centroid["lat"], centroid["lng"])
                    buffer_m = (_geometry_radius_m(geom, centroid) or 0.0) + radius_m
                    if not citywide and d > buffer_m:
                        continue
                    out.append({
                        "id": f"cordon:{r[0]}",
                        "kind": "cordon",
                        "severity": 4,
                        "title": "Avoid area",
                        "message": r[2] or "No-entry zone — do not approach.",
                        "geometry": geom,
                        "distance_m": round(d, 0),
                        "bearing": _compass_bearing(lat, lng, centroid["lat"], centroid["lng"]),
                        "event_id": str(r[3]) if r[3] is not None else None,
                        "source": "ai",
                        "created_at": r[4].isoformat(),
                    })

                # 3. AI-declared disasters
                geom_expr = _geometry_select_expr(cur)
                cur.execute(
                    f"""
                    SELECT id, disaster_type, severity, {geom_expr}, geometry_kind, created_at
                    FROM disaster_events
                    WHERE status = 'active' AND source = 'ai';
                    """
                )
                for r in cur.fetchall():
                    geom = _coerce_geojson(r[3])
                    gkind = r[4]
                    centroid = _geometry_centroid(geom)
                    # Citywide events with no geometry — surface unconditionally
                    if centroid is None:
                        if gkind == "city":
                            out.append({
                                "id": f"disaster:{r[0]}",
                                "kind": "disaster",
                                "severity": int(r[2]),
                                "title": str(r[1]).replace("_", " "),
                                "message": f"Citywide {r[1].replace('_',' ').lower()} in effect.",
                                "geometry": None,
                                "distance_m": 0,
                                "bearing": "N",
                                "event_id": str(r[0]),
                                "source": "ai",
                                "created_at": r[5].isoformat(),
                            })
                        continue
                    d = _distance_haversine(lat, lng, centroid["lat"], centroid["lng"])
                    buffer_m = (_geometry_radius_m(geom, centroid) or 0.0) + radius_m
                    if not citywide and d > buffer_m:
                        continue
                    out.append({
                        "id": f"disaster:{r[0]}",
                        "kind": "disaster",
                        "severity": int(r[2]),
                        "title": str(r[1]).replace("_", " "),
                        "message": f"{r[1].replace('_',' ')} active — severity {r[2]}.",
                        "geometry": geom,
                        "distance_m": round(d, 0),
                        "bearing": _compass_bearing(lat, lng, centroid["lat"], centroid["lng"]),
                        "event_id": str(r[0]),
                        "source": "ai",
                        "created_at": r[5].isoformat(),
                    })

                # 4. Active AI dispatches
                cur.execute(
                    """
                    SELECT id, event_id, service_type, target_lat, target_lng,
                           radius_m, unit_count, created_at
                    FROM active_dispatches
                    WHERE status = 'active'
                      AND source = 'ai'
                      AND expires_at > NOW();
                    """
                )
                for r in cur.fetchall():
                    d = _distance_haversine(lat, lng, float(r[3]), float(r[4]))
                    buffer_m = float(r[5] or 0) + radius_m
                    if not citywide and d > buffer_m:
                        continue
                    bearing = _compass_bearing(lat, lng, float(r[3]), float(r[4]))
                    label = _service_label(r[2])
                    out.append({
                        "id": f"dispatch:{r[0]}",
                        "kind": "dispatch",
                        "severity": 2,
                        "title": label,
                        "message": f"{label} active {int(d)} m {bearing} of you.",
                        "geometry": None,
                        "distance_m": round(d, 0),
                        "bearing": bearing,
                        "event_id": str(r[1]) if r[1] is not None else None,
                        "source": "ai",
                        "created_at": r[7].isoformat(),
                    })
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Warnings read failed: {exc}",
        )

    # 5. Weather alerts. The weather regions endpoint already computes
    # severity-tagged alert lists for every active weather-bending disaster.
    # Reuse that machinery so the danger thresholds stay in one place.
    try:
        weather_rows = _fetch_weather_driving_events()
    except Exception:
        weather_rows = []

    for event_id, disaster_type, severity, cause, geom, gkind in weather_rows:
        weather = _regional_weather(disaster_type, severity, cause, str(event_id))
        if not weather:
            continue
        alerts = weather.get("alerts") or []
        if not alerts:
            continue
        geom_dict = _coerce_geojson(geom)
        # Citywide weather (heatwave etc.) — relevant to every user.
        if gkind == "city" or geom_dict is None:
            distance = 0.0
            bearing = "—"
        else:
            centroid = _geometry_centroid(geom_dict)
            if centroid is None:
                continue
            distance = _distance_haversine(lat, lng, centroid["lat"], centroid["lng"])
            buffer_m = (_geometry_radius_m(geom_dict, centroid) or 0.0) + radius_m
            if not citywide and distance > buffer_m:
                continue
            bearing = _compass_bearing(lat, lng, centroid["lat"], centroid["lng"])
        # Surface each alert as its own entry so heat + air-quality don't get
        # collapsed into one row. The _alert() helper writes severity as a
        # band string ('minor'|'moderate'|'severe'|'extreme'); drop 'minor'.
        sev_band = {"minor": 1, "moderate": 3, "severe": 4, "extreme": 5}
        for idx, alert in enumerate(alerts):
            raw_sev = alert.get("severity")
            sev = sev_band.get(str(raw_sev), 2) if isinstance(raw_sev, str) else int(raw_sev or 2)
            if sev < 2:
                continue
            out.append({
                "id": f"weather:{event_id}:{alert.get('type','wx')}:{idx}",
                "kind": "weather",
                "severity": sev,
                "title": weather.get("label") or "Weather alert",
                "message": alert.get("headline") or alert.get("message") or weather.get("detail") or "Hazardous weather nearby.",
                "geometry": geom_dict,
                "distance_m": round(distance, 0),
                "bearing": bearing,
                "event_id": str(event_id),
                "source": "ai",
                "created_at": alert.get("start") or datetime.now(timezone.utc).isoformat(),
            })

    # Most severe first, then closest.
    out.sort(key=lambda w: (-int(w.get("severity") or 0), float(w.get("distance_m") or 0)))
    return {"warnings": out}


@app.get("/api/stats/injured", tags=["Admin"])
def stats_injured():
    """Sum people_inside * (1 - safe_exit_pct/100) across active events
    where both fields are present. Returns injured_estimate + contributing_events."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT people_inside, safe_exit_pct
                    FROM disaster_events
                    WHERE status = 'active'
                      AND people_inside IS NOT NULL
                      AND safe_exit_pct IS NOT NULL;
                """)
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Injured stat read failed: {exc}",
        )
    total = 0.0
    for people_inside, safe_pct in rows:
        total += float(people_inside) * (1.0 - float(safe_pct) / 100.0)
    return {
        "injured_estimate": int(round(total)),
        "contributing_events": len(rows),
    }


# ──────────────────────────────────────────────────────────────────────
# Fire stations — operator-placed map objects. Trucks spawn from / return
# to these. Persistent so the operator only places them once per deployment.
# ──────────────────────────────────────────────────────────────────────

@app.get("/api/fire-stations", tags=["Emergency Services"])
def list_fire_stations():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, lat, lng, created_at, truck_count, trucks_dispatched
                    FROM fire_stations
                    ORDER BY created_at ASC;
                """)
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Fire station read failed: {exc}",
        )
    return {
        "stations": [
            {
                "id": str(r[0]),
                "name": r[1],
                "lat": r[2],
                "lng": r[3],
                "created_at": r[4].isoformat(),
                "truck_count": r[5],
                "trucks_dispatched": r[6],
            }
            for r in rows
        ]
    }


@app.post("/api/fire-stations", tags=["Emergency Services"])
def create_fire_station(payload: FireStationPayload):
    station_id = payload.id or str(uuid.uuid4())
    truck_count = payload.truck_count if payload.truck_count is not None else 4
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO fire_stations (id, name, lat, lng, truck_count)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (station_id, payload.name, payload.lat, payload.lng, truck_count),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Fire station create failed: {exc}",
        )
    return {"success": True, "id": str(returned_id)}


@app.delete("/api/fire-stations/{station_id}", tags=["Emergency Services"])
def delete_fire_station(station_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM fire_stations WHERE id = %s;", (station_id,))
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Fire station delete failed: {exc}",
        )
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────
# Reset all *_dispatched counters across every station type. The engine is
# the source of truth for what's currently deployed; the DB counters track
# capacity allocation. When the frontend reloads, in-memory units are gone
# but the DB counters persist — that drift can leave a station permanently
# "at capacity" with zero actual units out. The dashboard calls this on
# startup to keep the counters honest.
# ──────────────────────────────────────────────────────────────────────

@app.post("/api/reset-dispatched", tags=["Emergency Services"])
def reset_dispatched_counters():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE fire_stations SET trucks_dispatched = 0;")
                fire = cur.rowcount
                cur.execute("UPDATE hospitals SET ambulances_dispatched = 0;")
                hosp = cur.rowcount
                cur.execute("UPDATE police_stations SET police_dispatched = 0;")
                pol = cur.rowcount
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Reset dispatched failed: {exc}",
        )
    return {"success": True, "fire_stations": fire, "hospitals": hosp, "police_stations": pol}


# ──────────────────────────────────────────────────────────────────────
# Dispatch — operator (or future AI) requests emergency-services units to
# travel from the nearest station to a target area. The dispatch itself is
# ephemeral (lives in the engine); only the resulting truck movement is
# observable. The endpoint validates input and returns a dispatch id so the
# caller can correlate logs / recall the units later.
# ──────────────────────────────────────────────────────────────────────

PENDING_DISPATCHES = []

@app.post("/api/dispatch", tags=["Emergency Services"])
def dispatch_units(payload: DispatchPayload):
    target = payload.target or {}
    lat = target.get("lat")
    lng = target.get("lng")
    radius = target.get("radius")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target.lat and target.lng are required (numbers).",
        )
    if radius is not None and (not isinstance(radius, (int, float)) or radius <= 0):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target.radius must be a positive number when provided.",
        )
    units = payload.units if payload.units is not None else payload.trucks
    if units is None or units < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="units (or trucks for firefighter) is required and must be >= 1.",
        )
    # The actual unit movement happens in the frontend citizen engine — this
    # endpoint just acknowledges the request and returns a correlation id.
    echo_target = {"lat": lat, "lng": lng}
    if radius is not None:
        echo_target["radius"] = radius

    dispatch_id = str(uuid.uuid4())
    global PENDING_DISPATCHES
    PENDING_DISPATCHES.append({
        "dispatch_id": dispatch_id,
        "kind": payload.kind,
        "units": units,
        "target": echo_target,
        "station_id": payload.station_id,
    })

    # Persist for /api/warnings/nearby. The ephemeral PENDING_DISPATCHES list
    # above is consumed once by /api/dispatch/pending; the active_dispatches
    # table lives until the row expires or is closed, so mobile clients
    # polling /api/warnings/nearby can still surface "fire response 800m N".
    src = payload.source or "operator"
    radius_m = float(radius) if radius is not None else 1500.0
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO active_dispatches
                        (id, event_id, service_type, target_lat, target_lng,
                         radius_m, unit_count, status, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, 'active', %s);
                    """,
                    (dispatch_id, payload.event_id, payload.kind,
                     float(lat), float(lng), radius_m, int(units), src),
                )
        conn.close()
    except Exception as exc:
        # Don't fail the dispatch if the persistence side errors — the engine
        # still does the visible work via PENDING_DISPATCHES.
        print(f"[active_dispatches] insert warning: {exc}")

    return {
        "success": True,
        "dispatch_id": dispatch_id,
        "kind": payload.kind,
        "units": units,
        "trucks": units,  # back-compat
        "target": echo_target,
        "station_id": payload.station_id,
    }


@app.get("/api/dispatch/pending", tags=["Emergency Services"])
def get_pending_dispatches():
    global PENDING_DISPATCHES
    res = list(PENDING_DISPATCHES)
    PENDING_DISPATCHES.clear()
    return {"dispatches": res}


# ──────────────────────────────────────────────────────────────────────
# Fire station capacity ack endpoints — engine notifies backend when units
# leave / return so trucks_dispatched reflects reality.
# ──────────────────────────────────────────────────────────────────────


def _atomic_dispatch_ack(table: str, count_col: str, dispatched_col: str,
                          station_id: str, units: int) -> bool:
    """Increment dispatched_col atomically, refusing if it would exceed count_col.
    Returns True on success, False if capacity would be exceeded or row missing."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {table}
                    SET {dispatched_col} = {dispatched_col} + %s
                    WHERE id = %s AND {dispatched_col} + %s <= {count_col}
                    RETURNING id;
                    """,
                    (units, station_id, units),
                )
                row = cur.fetchone()
        conn.close()
        return row is not None
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"{table} dispatch_ack failed: {exc}",
        )


def _atomic_return_ack(table: str, dispatched_col: str,
                        station_id: str, units: int) -> bool:
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    UPDATE {table}
                    SET {dispatched_col} = GREATEST({dispatched_col} - %s, 0)
                    WHERE id = %s
                    RETURNING id;
                    """,
                    (units, station_id),
                )
                row = cur.fetchone()
        conn.close()
        return row is not None
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"{table} return_ack failed: {exc}",
        )


@app.post("/api/fire-stations/{station_id}/dispatch_ack", tags=["Emergency Services"])
def fire_station_dispatch_ack(station_id: str, payload: UnitAckPayload):
    if not _atomic_dispatch_ack("fire_stations", "truck_count", "trucks_dispatched",
                                 station_id, payload.units):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Station at capacity or not found.")
    return {"success": True}


@app.post("/api/fire-stations/{station_id}/return_ack", tags=["Emergency Services"])
def fire_station_return_ack(station_id: str, payload: UnitAckPayload):
    _atomic_return_ack("fire_stations", "trucks_dispatched", station_id, payload.units)
    return {"success": True}


@app.patch("/api/fire-stations/{station_id}", tags=["Emergency Services"])
def patch_fire_station(station_id: str, payload: StationCountUpdate):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE fire_stations SET truck_count = %s WHERE id = %s RETURNING id;",
                    (payload.count, station_id),
                )
                row = cur.fetchone()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Fire station patch failed: {exc}",
        )
    if not row:
        raise HTTPException(status_code=404, detail="Station not found.")
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────
# Hospitals — operator-placed map objects. Ambulances spawn from / return to
# these. On arrival at a hospital a transported patient is healed.
# ──────────────────────────────────────────────────────────────────────


@app.get("/api/hospitals", tags=["Emergency Services"])
def list_hospitals():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, lat, lng, created_at, ambulance_count, ambulances_dispatched
                    FROM hospitals
                    ORDER BY created_at ASC;
                """)
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Hospital read failed: {exc}",
        )
    return {
        "hospitals": [
            {
                "id": str(r[0]),
                "name": r[1],
                "lat": r[2],
                "lng": r[3],
                "created_at": r[4].isoformat(),
                "ambulance_count": r[5],
                "ambulances_dispatched": r[6],
            }
            for r in rows
        ]
    }


@app.post("/api/hospitals", tags=["Emergency Services"])
def create_hospital(payload: HospitalPayload):
    hospital_id = payload.id or str(uuid.uuid4())
    ambulance_count = payload.ambulance_count if payload.ambulance_count is not None else 3
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO hospitals (id, name, lat, lng, ambulance_count)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (hospital_id, payload.name, payload.lat, payload.lng, ambulance_count),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Hospital create failed: {exc}",
        )
    return {"success": True, "id": str(returned_id)}


@app.delete("/api/hospitals/{hospital_id}", tags=["Emergency Services"])
def delete_hospital(hospital_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM hospitals WHERE id = %s;", (hospital_id,))
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Hospital delete failed: {exc}",
        )
    return {"success": True}


@app.patch("/api/hospitals/{hospital_id}", tags=["Emergency Services"])
def patch_hospital(hospital_id: str, payload: StationCountUpdate):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE hospitals SET ambulance_count = %s WHERE id = %s RETURNING id;",
                    (payload.count, hospital_id),
                )
                row = cur.fetchone()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Hospital patch failed: {exc}",
        )
    if not row:
        raise HTTPException(status_code=404, detail="Hospital not found.")
    return {"success": True}


@app.post("/api/hospitals/{hospital_id}/dispatch_ack", tags=["Emergency Services"])
def hospital_dispatch_ack(hospital_id: str, payload: UnitAckPayload):
    if not _atomic_dispatch_ack("hospitals", "ambulance_count", "ambulances_dispatched",
                                 hospital_id, payload.units):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Hospital at capacity or not found.")
    return {"success": True}


@app.post("/api/hospitals/{hospital_id}/return_ack", tags=["Emergency Services"])
def hospital_return_ack(hospital_id: str, payload: UnitAckPayload):
    _atomic_return_ack("hospitals", "ambulances_dispatched", hospital_id, payload.units)
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────
# Police stations — operator-placed map objects. ~50% of each station's
# roster auto-patrols at all times; the operator can manually dispatch more
# to specific circles for active incidents.
# ──────────────────────────────────────────────────────────────────────


@app.get("/api/police-stations", tags=["Emergency Services"])
def list_police_stations():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, lat, lng, created_at, police_count, police_dispatched
                    FROM police_stations
                    ORDER BY created_at ASC;
                """)
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Police station read failed: {exc}",
        )
    return {
        "stations": [
            {
                "id": str(r[0]),
                "name": r[1],
                "lat": r[2],
                "lng": r[3],
                "created_at": r[4].isoformat(),
                "police_count": r[5],
                "police_dispatched": r[6],
            }
            for r in rows
        ]
    }


@app.post("/api/police-stations", tags=["Emergency Services"])
def create_police_station(payload: PoliceStationPayload):
    station_id = payload.id or str(uuid.uuid4())
    police_count = payload.police_count if payload.police_count is not None else 10
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO police_stations (id, name, lat, lng, police_count)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (station_id, payload.name, payload.lat, payload.lng, police_count),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Police station create failed: {exc}",
        )
    return {"success": True, "id": str(returned_id)}


@app.delete("/api/police-stations/{station_id}", tags=["Emergency Services"])
def delete_police_station(station_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM police_stations WHERE id = %s;", (station_id,))
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Police station delete failed: {exc}",
        )
    return {"success": True}


@app.patch("/api/police-stations/{station_id}", tags=["Emergency Services"])
def patch_police_station(station_id: str, payload: StationCountUpdate):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE police_stations SET police_count = %s WHERE id = %s RETURNING id;",
                    (payload.count, station_id),
                )
                row = cur.fetchone()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Police station patch failed: {exc}",
        )
    if not row:
        raise HTTPException(status_code=404, detail="Station not found.")
    return {"success": True}


@app.post("/api/police-stations/{station_id}/dispatch_ack", tags=["Emergency Services"])
def police_station_dispatch_ack(station_id: str, payload: UnitAckPayload):
    if not _atomic_dispatch_ack("police_stations", "police_count", "police_dispatched",
                                 station_id, payload.units):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Station at capacity or not found.")
    return {"success": True}


@app.post("/api/police-stations/{station_id}/return_ack", tags=["Emergency Services"])
def police_station_return_ack(station_id: str, payload: UnitAckPayload):
    _atomic_return_ack("police_stations", "police_dispatched", station_id, payload.units)
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────
# Citizen evacuation notifications — operator marks a polygon + reason.
# Persisted so AI consumers and the frontend can list active alerts.
# ──────────────────────────────────────────────────────────────────────

@app.post("/api/notify", tags=["Emergency Services"])
def create_notification(payload: NotificationPayload):
    notif_id = str(uuid.uuid4())
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="reason is required.",
        )
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO notifications (id, geometry, reason, status, event_id, source)
                    VALUES (%s, %s, %s, 'active', %s, %s)
                    RETURNING id;
                    """,
                    (notif_id, json.dumps(payload.geometry), payload.reason.strip(),
                     payload.event_id, payload.source or "operator"),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Notification create failed: {exc}",
        )
    return {"success": True, "id": str(returned_id)}


@app.get("/api/notifications", tags=["Emergency Services"])
def list_notifications(status_filter: Optional[str] = Query("active", description="active|cleared|all")):
    where = ""
    params: List[Any] = []
    if status_filter and status_filter != "all":
        where = "WHERE status = %s"
        params.append(status_filter)
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, geometry, reason, status, created_at, event_id, source
                    FROM notifications
                    {where}
                    ORDER BY created_at DESC;
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Notification read failed: {exc}",
        )
    return {
        "notifications": [
            {
                "id": str(r[0]),
                "geometry": r[1],
                "reason": r[2],
                "status": r[3],
                "created_at": r[4].isoformat(),
                "event_id": str(r[5]) if r[5] is not None else None,
                "source": r[6] or "operator",
            }
            for r in rows
        ]
    }


@app.delete("/api/notifications/{notif_id}", tags=["Emergency Services"])
def clear_notification(notif_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE notifications SET status = 'cleared' WHERE id = %s;",
                    (notif_id,),
                )
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Notification clear failed: {exc}",
        )
    return {"success": True}


# ──────────────────────────────────────────────────────────────────────
# Cordons — operator-marked "no entry" zones. The frontend citizen engine
# refuses to walk citizens (but not trucks) onto road nodes inside the
# polygon. Citizens already mid-walk stop at the boundary until the cordon
# is cleared.
# ──────────────────────────────────────────────────────────────────────

@app.post("/api/cordons", tags=["Emergency Services"])
def create_cordon(payload: CordonPayload):
    cordon_id = str(uuid.uuid4())
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO cordons (id, geometry, reason, status, event_id, source)
                    VALUES (%s, %s, %s, 'active', %s, %s)
                    RETURNING id;
                    """,
                    (cordon_id, json.dumps(payload.geometry),
                     (payload.reason or "").strip() or None,
                     payload.event_id, payload.source or "operator"),
                )
                returned_id = cur.fetchone()[0]
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Cordon create failed: {exc}",
        )
    return {"success": True, "id": str(returned_id)}


@app.get("/api/cordons", tags=["Emergency Services"])
def list_cordons(status_filter: Optional[str] = Query("active", description="active|cleared|all")):
    where = ""
    params: List[Any] = []
    if status_filter and status_filter != "all":
        where = "WHERE status = %s"
        params.append(status_filter)
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, geometry, reason, status, created_at, event_id, source
                    FROM cordons
                    {where}
                    ORDER BY created_at DESC;
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Cordon read failed: {exc}",
        )
    return {
        "cordons": [
            {
                "id": str(r[0]),
                "geometry": r[1],
                "reason": r[2],
                "status": r[3],
                "created_at": r[4].isoformat(),
                "event_id": str(r[5]) if r[5] is not None else None,
                "source": r[6] or "operator",
            }
            for r in rows
        ]
    }


@app.delete("/api/cordons/{cordon_id}", tags=["Emergency Services"])
def clear_cordon(cordon_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE cordons SET status = 'cleared' WHERE id = %s;",
                    (cordon_id,),
                )
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Cordon clear failed: {exc}",
        )
    return {"success": True}


# ══════════════════════════════════════════════════════════════════════
# Mobile clients (Citizens & Emergency Workers) + Admin views
#
# These endpoints back the Expo mobile app (/mobile). They run on in-memory
# state seeded at startup so they require no DB migrations and reset on a
# server restart — which is the right behavior for the demo where mock-AI
# agents will eventually drive these numbers.
# ══════════════════════════════════════════════════════════════════════

from threading import Lock as _MobileLock

_mobile_lock = _MobileLock()

# Default seed location: Manhattan (matches frontend default city).
_DEFAULT_LAT = 40.7580
_DEFAULT_LNG = -73.9855


def _seed_citizen(idx: int, name: str, lat_offset: float, lng_offset: float) -> Dict[str, Any]:
    return {
        "id": f"citizen-{idx}",
        "name": name,
        "role": "citizen",
        "lat": _DEFAULT_LAT + lat_offset,
        "lng": _DEFAULT_LNG + lng_offset,
        "status": "safe",  # safe | warned | evacuating | affected
        "last_seen": datetime.utcnow().isoformat() + "Z",
    }


def _seed_worker(idx: int, name: str, role: str, lat_offset: float, lng_offset: float) -> Dict[str, Any]:
    return {
        "id": f"worker-{idx}",
        "name": name,
        "role": role,  # firefighter | paramedic | police
        "lat": _DEFAULT_LAT + lat_offset,
        "lng": _DEFAULT_LNG + lng_offset,
        "status": "available",  # available | dispatched | on_scene | off_duty
        "last_seen": datetime.utcnow().isoformat() + "Z",
    }


# Mobile-app user rosters. Populated dynamically by the PIN login endpoint.
# Reset on backend restart — acceptable for hackathon scope.
MOBILE_CITIZENS: Dict[str, Dict[str, Any]] = {}
MOBILE_WORKERS: Dict[str, Dict[str, Any]] = {}
MOBILE_ADMINS: Dict[str, Dict[str, Any]] = {}


# Pattern PIN → role mapping. The first/last digit identifies the role; middle
# digits are free. This is hackathon-grade auth: anyone who knows the pattern
# can assume any role.
_PIN_ROLE_MAP: Dict[str, Dict[str, Any]] = {
    "1": {"role": "citizen"},
    "2": {"role": "worker", "sub_role": "firefighter"},
    "3": {"role": "worker", "sub_role": "police"},
    "4": {"role": "worker", "sub_role": "paramedic"},
    "5": {"role": "admin"},
}

_NAME_PREFIX_BY_SLOT: Dict[str, str] = {
    "citizen": "Citizen",
    "firefighter": "FF",
    "police": "PD",
    "paramedic": "EMS",
    "admin": "Operator",
}


class MobileUserUpdate(BaseModel):
    lat: Optional[float] = None
    lng: Optional[float] = None
    status: Optional[str] = None


@app.post("/api/auth/login", tags=["Mobile"])
def auth_login(payload: LoginPayload):
    """Pattern PIN login. Returns a session record, upserts the user into the
    appropriate roster so the operator console can see them."""
    pin = (payload.pin or "").strip()
    device_id = (payload.device_id or "").strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required.")
    # Throttle credential attempts per device (brute-force / spam guard).
    _rate_limit(f"login:{device_id}", max_events=20, window_s=60.0)
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(status_code=401, detail="Invalid PIN")
    if pin[0] != pin[3] or pin[0] not in _PIN_ROLE_MAP:
        raise HTTPException(status_code=401, detail="Invalid PIN")
    mapping = _PIN_ROLE_MAP[pin[0]]
    role = mapping["role"]
    sub_role = mapping.get("sub_role")
    slot_key = sub_role if role == "worker" else role
    name_prefix = _NAME_PREFIX_BY_SLOT[slot_key]
    short_id = device_id.replace("-", "")[:4].upper() or "USER"
    friendly_name = f"{name_prefix}-{short_id}"
    now = datetime.utcnow().isoformat() + "Z"
    with _mobile_lock:
        # Deterministic small offset so multiple logins don't pile up at one point.
        offset_seed = sum(ord(c) for c in device_id) % 100
        lat_off = (offset_seed - 50) * 0.0001
        lng_off = ((offset_seed * 7) % 100 - 50) * 0.0001
        default_lat = _DEFAULT_LAT + lat_off
        default_lng = _DEFAULT_LNG + lng_off
        if role == "citizen":
            existing = MOBILE_CITIZENS.get(device_id)
            MOBILE_CITIZENS[device_id] = {
                "id": device_id,
                "name": friendly_name,
                "role": "citizen",
                "lat": existing["lat"] if existing else default_lat,
                "lng": existing["lng"] if existing else default_lng,
                "status": existing["status"] if existing else "safe",
                "last_seen": now,
            }
        elif role == "worker":
            # Workers are scoped per (device + sub_role) so a single phone
            # signing in as firefighter then police gets two distinct records.
            # Without this, the firefighter's pin/position would leak into
            # the police session and vice versa (shared single record per
            # device_id was the previous bug).
            worker_key = f"{device_id}:{sub_role}"
            existing = MOBILE_WORKERS.get(worker_key)
            MOBILE_WORKERS[worker_key] = {
                "id": worker_key,
                "name": friendly_name,
                "role": sub_role,  # Keep field name 'role' for backward compat with frontend
                "sub_role": sub_role,
                "lat": existing["lat"] if existing else default_lat,
                "lng": existing["lng"] if existing else default_lng,
                "status": existing["status"] if existing else "available",
                "last_seen": now,
            }
        else:  # admin
            MOBILE_ADMINS[device_id] = {
                "id": device_id,
                "name": friendly_name,
                "role": "admin",
                "last_seen": now,
            }
    # Workers identify by composite key — every subsequent /api/workers/<id>
    # call from the mobile uses this. Citizens/admins still use device_id.
    user_id_out = f"{device_id}:{sub_role}" if role == "worker" else device_id
    response: Dict[str, Any] = {
        "user_id": user_id_out,
        "role": role,
        "name": friendly_name,
    }
    if sub_role:
        response["sub_role"] = sub_role
    return response


# ────── Citizens ──────

@app.get("/api/citizens", tags=["Mobile"])
def list_citizens():
    """Return the current roster of mobile-app citizen users."""
    with _mobile_lock:
        return {"citizens": list(MOBILE_CITIZENS.values())}


@app.get("/api/citizens/{citizen_id}", tags=["Mobile"])
def get_citizen(citizen_id: str):
    with _mobile_lock:
        citizen = MOBILE_CITIZENS.get(citizen_id)
    if citizen is None:
        raise HTTPException(status_code=404, detail="Citizen not found.")
    return citizen


@app.patch("/api/citizens/{citizen_id}", tags=["Mobile"])
def update_citizen(citizen_id: str, update: MobileUserUpdate):
    """Update a citizen's location (mock-location feature) or status."""
    with _mobile_lock:
        citizen = MOBILE_CITIZENS.get(citizen_id)
        if citizen is None:
            raise HTTPException(status_code=404, detail="Citizen not found.")
        if update.lat is not None:
            citizen["lat"] = update.lat
        if update.lng is not None:
            citizen["lng"] = update.lng
        if update.status is not None:
            citizen["status"] = update.status
        citizen["last_seen"] = datetime.utcnow().isoformat() + "Z"
        return citizen


# ────── Emergency Workers ──────

@app.get("/api/workers", tags=["Mobile"])
def list_workers():
    """Return the current roster of mobile-app emergency-worker users."""
    with _mobile_lock:
        return {"workers": list(MOBILE_WORKERS.values())}


@app.get("/api/workers/{worker_id}", tags=["Mobile"])
def get_worker(worker_id: str):
    with _mobile_lock:
        worker = MOBILE_WORKERS.get(worker_id)
    if worker is None:
        raise HTTPException(status_code=404, detail="Worker not found.")
    return worker


@app.patch("/api/workers/{worker_id}", tags=["Mobile"])
def update_worker(worker_id: str, update: MobileUserUpdate):
    with _mobile_lock:
        worker = MOBILE_WORKERS.get(worker_id)
        if worker is None:
            raise HTTPException(status_code=404, detail="Worker not found.")
        if update.lat is not None:
            worker["lat"] = update.lat
        if update.lng is not None:
            worker["lng"] = update.lng
        if update.status is not None:
            worker["status"] = update.status
        worker["last_seen"] = datetime.utcnow().isoformat() + "Z"
        return worker


@app.delete("/api/workers/{worker_id}", tags=["Mobile"])
def delete_worker(worker_id: str):
    """Remove a worker from the in-memory roster. Used to evict stale test
    sessions (e.g. PD-TEST / FF-TEST) that were created by curl/Postman
    traffic and don't correspond to a real phone. The worker can re-upsert
    by signing in again — POST /api/auth/login is the source of truth."""
    with _mobile_lock:
        worker = MOBILE_WORKERS.pop(worker_id, None)
    if worker is None:
        raise HTTPException(status_code=404, detail="Worker not found.")
    return {"deleted": True, "id": worker_id, "name": worker.get("name")}


# ════════════════════════════════════════════════════════════════════
# 911 calls — citizen-initiated, surfaced to police via the call log
# ════════════════════════════════════════════════════════════════════
#
# Citizen taps "Call 911" while inside an active disaster zone. The mobile
# app pre-fills the call with disaster context (type, severity, footprint,
# the citizen's own coords + name) so dispatch knows what they're walking
# into before they even pick up.
#
# Persisted in Postgres (table emergency_calls) so the live call log and the
# per-service accept/resolve lanes survive backend restarts and can be served
# by more than one instance. The photo blob lives in its own column and is
# never selected into the list feed (fetched on demand via the photo endpoint).

# Columns written on insert (full record, incl. the photo blob).
_CALL_INSERT_COLS = [
    "id", "created_at", "citizen_id", "citizen_name", "caller_lat", "caller_lng",
    "disaster_id", "disaster_type", "severity", "cause", "disaster_lat", "disaster_lng",
    "is_direct", "category", "transcript", "requested_services", "service_status",
    "status", "acknowledged_by", "acknowledged_at", "closed_at", "responders",
    "photo_data_url", "ai_assessment", "idempotency_key", "caller_profile", "summary",
]
# Columns returned to clients — everything except the heavy photo blob.
_CALL_READ_COLS = [c for c in _CALL_INSERT_COLS if c != "photo_data_url"]
_CALL_JSON_COLS = {"requested_services", "service_status", "responders", "ai_assessment", "caller_profile"}
_CALL_TS_COLS = {"created_at", "acknowledged_at", "closed_at"}


def _call_insert_values(call: Dict[str, Any]) -> list:
    out = []
    for col in _CALL_INSERT_COLS:
        v = call.get(col)
        if col in _CALL_JSON_COLS and v is not None:
            v = psycopg2.extras.Json(v)
        out.append(v)
    return out


def _row_to_public_call(row) -> Dict[str, Any]:
    """Map a SELECT of (_CALL_READ_COLS..., has_photo) → the public call dict."""
    d: Dict[str, Any] = {}
    for col, v in zip(_CALL_READ_COLS, row):
        if col in _CALL_TS_COLS and v is not None and hasattr(v, "isoformat"):
            v = v.isoformat()
        d[col] = v
    d["has_photo"] = bool(row[len(_CALL_READ_COLS)])
    if not d.get("service_status"):
        d["service_status"] = {s: d.get("status", "new") for s in (d.get("requested_services") or [])}
    return d


_READ_SELECT = ", ".join(_CALL_READ_COLS) + ", (photo_data_url IS NOT NULL)"


def _db_insert_call(call: Dict[str, Any]) -> None:
    cols = ", ".join(_CALL_INSERT_COLS)
    ph = ", ".join(["%s"] * len(_CALL_INSERT_COLS))
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(f"INSERT INTO emergency_calls ({cols}) VALUES ({ph});", _call_insert_values(call))
    finally:
        conn.close()


def _db_list_calls() -> List[Dict[str, Any]]:
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT {_READ_SELECT} FROM emergency_calls ORDER BY created_at DESC LIMIT 500;")
                rows = cur.fetchall()
    finally:
        conn.close()
    return [_row_to_public_call(r) for r in rows]


def _db_get_call(call_id: str) -> Optional[Dict[str, Any]]:
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT {_READ_SELECT} FROM emergency_calls WHERE id = %s;", (call_id,))
                row = cur.fetchone()
    finally:
        conn.close()
    return _row_to_public_call(row) if row else None


def _db_get_call_photo(call_id: str) -> Optional[str]:
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT photo_data_url FROM emergency_calls WHERE id = %s;", (call_id,))
                row = cur.fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _db_call_id_by_idempotency(key: str) -> Optional[str]:
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM emergency_calls WHERE idempotency_key = %s LIMIT 1;", (key,))
                row = cur.fetchone()
    finally:
        conn.close()
    return str(row[0]) if row else None


def _db_update_call(call_id: str, **fields: Any) -> None:
    if not fields:
        return
    sets, vals = [], []
    for col, v in fields.items():
        if col in _CALL_JSON_COLS and v is not None:
            v = psycopg2.extras.Json(v)
        sets.append(f"{col} = %s")
        vals.append(v)
    vals.append(call_id)
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE emergency_calls SET {', '.join(sets)} WHERE id = %s;", vals)
    finally:
        conn.close()


EMERGENCY_SERVICES = ("ambulance", "police", "firefighter")
# Sub-role on the workers roster → which 911 service this worker can answer.
# Each call has one or more requested_services; a worker only sees calls
# whose requested set intersects their sub-role.
SUBROLE_TO_SERVICE: Dict[str, str] = {
    "paramedic": "ambulance",
    "police": "police",
    "firefighter": "firefighter",
}


class EmergencyCallPayload(BaseModel):
    """Body for POST /api/911/call. Citizen submits this on tap."""
    citizen_id: str = Field(..., description="Mobile device_id of the caller.")
    # Optional. When the caller is reporting a specific declared disaster the app
    # passes its id for context; for a direct SOS (the citizen calling for help
    # with no declared disaster) it is omitted. We never reject a call based on
    # the disaster's existence or status — help must always go through.
    disaster_id: Optional[str] = Field(
        None, description="UUID of the disaster being reported, if any."
    )
    # Free-form emergency category for a direct SOS (e.g. 'Medical', 'Fire',
    # 'Crime', 'Accident', 'Trapped', 'Other'). Used as the call's headline when
    # there is no linked disaster so dispatch still has context.
    category: Optional[str] = Field(
        None, description="Emergency category for a direct (non-disaster) SOS call."
    )
    # Citizen's own coordinates at call time. Stored alongside the disaster
    # location so dispatch can see exactly where the caller is, even if they
    # walk away from the zone after placing the call.
    caller_lat: float
    caller_lng: float
    # The auto-generated script the citizen "spoke" — composed client-side
    # so the citizen can review what dispatch will hear before they tap call.
    transcript: str
    # Which emergency service(s) the citizen requested via the in-app prompt.
    # At least one required; ['ambulance','police','firefighter'] means "all
    # services" and fans out to every responder type.
    requested_services: List[Literal["ambulance", "police", "firefighter"]] = Field(
        ..., min_length=1,
    )
    # Optional photographic proof, as a base64 data URL ("data:image/jpeg;base64,…").
    # The citizen captures it in-app; an AI authenticity check (see
    # pipeline.prank_check) weighs it against the transcript so dispatch can tell a
    # real emergency from a likely prank. Optional by design — a 911 call must never
    # be blocked on a camera.
    photo_data_url: Optional[str] = Field(
        None, description="Base64 data URL of the proof photo, if the citizen attached one."
    )
    # Client-generated key (one per call attempt). A retry of the SAME attempt
    # reuses the key so we return the original call instead of dispatching twice.
    idempotency_key: Optional[str] = Field(
        None, description="Idempotency key — retries with the same key return the same call."
    )
    # Caller's saved profile (vitals/medical/contact). Stored with the call and
    # shown to the operator / responders — NOT spoken in the transcript.
    caller_profile: Optional[Dict[str, Any]] = Field(
        None, description="Caller's saved profile, attached so dispatch can identify/brief without it being in the transcript."
    )
    # Optional concise dispatch brief (set when the call came from the AI operator).
    summary: Optional[str] = Field(
        None, description="Concise responder-facing dispatch brief; None for a plain tap call."
    )


def _public_call(call: Dict[str, Any]) -> Dict[str, Any]:
    """A 911 call record safe to return in list/detail payloads: everything except
    the heavy base64 photo blob (fetched on demand via /api/911/calls/{id}/photo).
    Exposes `has_photo` so clients know whether to offer the photo view."""
    public = {k: v for k, v in call.items() if k != "photo_data_url"}
    public["has_photo"] = bool(call.get("photo_data_url"))
    # Back-fill per-service lanes for any record created before service_status
    # existed, so every client always gets one.
    if "service_status" not in public:
        public["service_status"] = {
            s: call.get("status", "new") for s in call.get("requested_services", [])
        }
    return public


def _run_call_assessment(call_id: str, transcript: str, disaster_type: Optional[str],
                         severity: Optional[int], photo_data_url: Optional[str]) -> None:
    """Background task: run the AI authenticity check and attach the verdict to the
    persisted call. Advisory only — failures leave the call flagged-but-untouched."""
    try:
        from pipeline.prank_check import assess_call
        assessment = assess_call(transcript, disaster_type, severity, photo_data_url)
    except Exception as exc:  # noqa: BLE001 - never let a background task crash silently
        logging.getLogger("sentinel.prank_check").warning(
            "prank assessment failed for call %s: %s", call_id, exc
        )
        assessment = {
            "status": "unavailable",
            "verdict": "uncertain",
            "confidence": 0.0,
            "reasoning": "AI authenticity check could not run.",
        }
    try:
        _db_update_call(call_id, ai_assessment=assessment)
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("sentinel.prank_check").warning("could not persist assessment for %s: %s", call_id, exc)


def _place_emergency_call(
    *,
    citizen_id: str,
    caller_lat: float,
    caller_lng: float,
    requested_services: List[str],
    transcript: str,
    background_tasks: BackgroundTasks,
    disaster_id: Optional[str] = None,
    category: Optional[str] = None,
    photo_data_url: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    caller_profile: Optional[Dict[str, Any]] = None,
    summary: Optional[str] = None,
    severity_override: Optional[int] = None,
) -> Dict[str, Any]:
    """Shared path that builds, persists and dispatches a 911 call. Used by both
    the citizen tap endpoint (POST /api/911/call) and the AI operator's
    end-of-call dispatch. Joins citizen + disaster context, runs the same
    idempotency / rate-limit / AI-authenticity flow, and returns the public call.
    Raises HTTPException on bad input (no citizen, no valid service)."""
    # Idempotency (#6): a retried submission with the same key returns the call
    # already created instead of dispatching responders twice. DB-backed, so it
    # holds across restarts and multiple instances.
    if idempotency_key:
        existing_id = _db_call_id_by_idempotency(idempotency_key)
        if existing_id:
            existing = _db_get_call(existing_id)
            if existing:
                return existing
    # Spam guard (#7) — generous so a genuine caller is never blocked.
    _rate_limit(f"call:{citizen_id}", max_events=10, window_s=60.0)

    # Citizen resolution — we surface the friendly name in the call log.
    with _mobile_lock:
        citizen = MOBILE_CITIZENS.get(citizen_id)
    if citizen is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Citizen not found — sign in again.",
        )

    # Disaster context is OPTIONAL and best-effort. If the caller referenced a
    # disaster we attach its details for dispatch context — but we deliberately
    # do NOT reject the call if that disaster is missing or already cleared, and a
    # direct SOS (no disaster_id) is always allowed. A 911 call must never fail on
    # disaster state; help comes first, triage second.
    row = None
    if disaster_id:
        try:
            conn = psycopg2.connect(DATABASE_URL)
            try:
                with conn:
                    with conn.cursor() as cur:
                        geom_expr = _geometry_select_expr(cur)
                        cur.execute(
                            f"""
                            SELECT id, disaster_type, severity, cause, status,
                                   {geom_expr}, geometry_kind
                            FROM disaster_events
                            WHERE id = %s;
                            """,
                            (disaster_id,),
                        )
                        row = cur.fetchone()
            finally:
                conn.close()
        except Exception as exc:
            # Log + continue as a direct call rather than failing the emergency.
            logging.getLogger("sentinel.911").warning(
                "disaster lookup failed for call (treating as direct SOS): %s", exc
            )
            row = None

    is_direct = row is None
    if is_direct:
        # Direct SOS — no (usable) disaster context. Headline from the category.
        disaster_id_out = None
        disaster_type = (category or "Direct emergency").strip() or "Direct emergency"
        # Unverified urgency — dispatch + the AI authenticity check do the triage.
        severity = 3
        cause = None
        disaster_centroid = None
    else:
        disaster_id_out = str(row[0])
        disaster_type = row[1]
        severity = row[2]
        cause = row[3]
        disaster_geom = _coerce_geojson(row[5])
        disaster_centroid = _geometry_centroid(disaster_geom)

    # The AI operator's judged severity (when provided) wins over the placeholder.
    if severity_override is not None:
        try:
            severity = max(1, min(5, int(severity_override)))
        except (TypeError, ValueError):
            pass

    # De-dupe + canonicalise requested_services. The citizen UI sends
    # ['ambulance','police','firefighter'] for "all services"; we keep it as a
    # list rather than a flag so adding new service types later is non-breaking.
    services = sorted({s for s in requested_services if s in EMERGENCY_SERVICES})
    if not services:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one valid requested service is required.",
        )

    call = {
        "id": str(uuid.uuid4()),
        "created_at": datetime.utcnow().isoformat() + "Z",
        # Citizen context
        "citizen_id": citizen_id,
        "citizen_name": citizen.get("name") or "Unknown caller",
        "caller_lat": caller_lat,
        "caller_lng": caller_lng,
        # Disaster context — frozen at call time so the log reads correctly
        # even after the operator bumps severity or clears the event. For a
        # direct SOS these are derived from the category (see above).
        "disaster_id": disaster_id_out,
        "disaster_type": disaster_type,
        "severity": severity,
        "cause": cause,
        "disaster_lat": disaster_centroid["lat"] if disaster_centroid else None,
        "disaster_lng": disaster_centroid["lng"] if disaster_centroid else None,
        # True when this is a direct SOS not tied to any declared disaster.
        "is_direct": is_direct,
        "category": (category or None),
        # Transcript: the citizen's scripted statement, or the AI-operator call
        # transcript. The concise responder-facing brief is `summary` below.
        "transcript": (transcript or "").strip() or "(no transcript provided)",
        # Concise AI-operator dispatch brief for responders (None for tap calls).
        "summary": (summary.strip() if isinstance(summary, str) and summary.strip() else None),
        # Service routing — which responder types the citizen asked for.
        "requested_services": services,
        # Per-service lifecycle: each requested service accepts/resolves on its
        # OWN lane, independently. A firefighter acknowledging or resolving does
        # not change the ambulance/police lanes. The top-level `status` below is
        # a derived summary (for admin/back-compat); per-lane truth lives here.
        "service_status": {s: "new" for s in services},
        # Lifecycle summary: new → acknowledged → closed. Derived from the lanes.
        "status": "new",
        "acknowledged_by": None,
        "acknowledged_at": None,
        "closed_at": None,
        # Identity of the worker(s) who acknowledged. Multiple responders can
        # roll on a single call (e.g. ambulance + police on a major incident).
        "responders": [],  # list of {worker_id, sub_role, acknowledged_at}
        # Photographic proof + AI authenticity check. The photo blob is kept out
        # of list payloads (see _public_call) and fetched on demand. The
        # assessment is filled in by a background task moments after the call is
        # created, so the call itself reaches dispatch with zero added latency.
        "photo_data_url": (photo_data_url or None),
        "ai_assessment": {"status": "analyzing"},
        "idempotency_key": (idempotency_key or None),
        "caller_profile": (caller_profile or None),
    }
    _db_insert_call(call)

    # Kick off the AI authenticity check after the response is sent.
    background_tasks.add_task(
        _run_call_assessment,
        call["id"], call["transcript"], call["disaster_type"], call["severity"],
        call["photo_data_url"],
    )
    return _public_call(call)


@app.post("/api/911/call", tags=["911"])
def create_emergency_call(payload: EmergencyCallPayload, background_tasks: BackgroundTasks):
    """Citizens-only endpoint. Builds an enriched call record by joining the
    citizen + disaster details and persists it to the emergency_calls table."""
    return _place_emergency_call(
        citizen_id=payload.citizen_id,
        caller_lat=payload.caller_lat,
        caller_lng=payload.caller_lng,
        requested_services=payload.requested_services,
        transcript=payload.transcript,
        background_tasks=background_tasks,
        disaster_id=payload.disaster_id,
        category=payload.category,
        photo_data_url=payload.photo_data_url,
        idempotency_key=payload.idempotency_key,
        caller_profile=payload.caller_profile,
        summary=payload.summary,
    )


@app.get("/api/911/calls", tags=["911"])
def list_emergency_calls(
    status_filter: Optional[str] = Query(None, description="new|acknowledged|closed|all"),
    service: Optional[str] = Query(
        None,
        description="ambulance|police|firefighter — restrict to calls requesting this service. Workers should pass their own service to see their queue.",
    ),
):
    """Newest-first dispatch feed. Workers filter by `service` to see only
    calls relevant to their unit; admins / operators omit it for the full feed.
    Already newest-first and photo-stripped from the DB query."""
    if service and service not in EMERGENCY_SERVICES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"service must be one of {EMERGENCY_SERVICES}",
        )
    rows = _db_list_calls()
    if status_filter and status_filter != "all":
        rows = [c for c in rows if c["status"] == status_filter]
    if service:
        rows = [c for c in rows if service in (c.get("requested_services") or [])]
    return {"calls": rows}


@app.get("/api/911/calls/{call_id}/photo", tags=["911"])
def get_emergency_call_photo(call_id: str):
    """Return the proof photo (base64 data URL) for one call, on demand. Kept out
    of the list feed so the frequently-polled dispatch queue stays lightweight."""
    data_url = _db_get_call_photo(call_id)
    if not data_url:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No photo on this call.")
    return {"id": call_id, "photo_data_url": data_url}


class EmergencyCallUpdate(BaseModel):
    status: Optional[Literal["new", "acknowledged", "closed"]] = None
    # When a worker acknowledges, the client sends their userId + sub-role so
    # we can record who's rolling. Multiple workers can acknowledge the same
    # call (e.g. ambulance + police on a serious incident).
    worker_id: Optional[str] = None
    sub_role: Optional[Literal["paramedic", "police", "firefighter"]] = None


@app.patch("/api/911/calls/{call_id}", tags=["911"])
def update_emergency_call(call_id: str, update: EmergencyCallUpdate):
    """Accept (acknowledge) or resolve (close) a call. The transition applies to
    the acting worker's OWN service lane only — so when a citizen requested
    ambulance + police + firefighter, each unit accepts/resolves independently
    and one acting never removes the call from the others. The worker's `sub_role`
    identifies which lane to change; the top-level `status` is re-derived as a
    summary. With no sub_role (e.g. an admin), the change applies to every lane."""
    now = datetime.utcnow().isoformat() + "Z"
    c = _db_get_call(call_id)
    if c is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found.")

    lanes: Dict[str, str] = c.get("service_status") or {
        s: c.get("status", "new") for s in (c.get("requested_services") or [])
    }
    service = SUBROLE_TO_SERVICE.get(update.sub_role) if update.sub_role else None

    if update.status:
        if service and service in lanes:
            lanes[service] = update.status          # only this responder's lane moves
        else:
            for s in list(lanes.keys()):            # no lane context → whole call
                lanes[s] = update.status

    responders = list(c.get("responders") or [])
    if update.worker_id and update.sub_role:
        if not any(r.get("worker_id") == update.worker_id for r in responders):
            responders.append({
                "worker_id": update.worker_id,
                "sub_role": update.sub_role,
                "acknowledged_at": now,
            })
        c["acknowledged_by"] = update.worker_id  # legacy single-string field

    # Re-derive the summary status from the lanes.
    vals = list(lanes.values()) or [c.get("status", "new")]
    if all(v == "closed" for v in vals):
        c["status"] = "closed"
        c["closed_at"] = c.get("closed_at") or now
    elif any(v in ("acknowledged", "closed") for v in vals):
        c["status"] = "acknowledged"
        c["acknowledged_at"] = c.get("acknowledged_at") or now
    else:
        c["status"] = "new"

    c["service_status"] = lanes
    c["responders"] = responders
    _db_update_call(
        call_id,
        service_status=lanes,
        responders=responders,
        status=c["status"],
        acknowledged_by=c.get("acknowledged_by"),
        acknowledged_at=c.get("acknowledged_at"),
        closed_at=c.get("closed_at"),
    )
    return c


# ════════════════════════════════════════════════════════════════════
# AI 911 operator — live, guardrailed conversational dispatch
#
# The citizen holds a real back-and-forth call (voice transcribed to text, or
# typed) with an LLM operator (see pipeline.operator). The operator gathers what
# happened + where, decides which responders to send, and on end-of-call emits a
# concise dispatch brief. The full conversation (caller chat + operator replies +
# summary) is persisted to operator_call_logs for AUDIT, upserted per turn so an
# abandoned call is still captured.
#
# Sessions live in memory for the duration of one call (short-lived); the durable
# records are the audit log + the dispatched emergency_call. A 911 line must
# NEVER go dead, so every model failure degrades to a safe holding reply /
# all-services dispatch (see pipeline.operator's never-raise contract).
# ════════════════════════════════════════════════════════════════════

_operator_lock = _MobileLock()
# session_id -> session dict. Short-lived (one live call). Pruned on access.
OPERATOR_SESSIONS: Dict[str, Dict[str, Any]] = {}
_OPERATOR_SESSION_TTL_S = 60 * 60  # 1h — a single call won't outlive this.


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _prune_operator_sessions() -> None:
    cutoff = time.monotonic() - _OPERATOR_SESSION_TTL_S
    for sid in [s for s, v in OPERATOR_SESSIONS.items() if v.get("_touched", 0) < cutoff]:
        OPERATOR_SESSIONS.pop(sid, None)


def _operator_ctx(session: Dict[str, Any]) -> Dict[str, Any]:
    """The context pipeline.operator needs: caller location (for the 'my location'
    shortcut) + any seeded category / disaster context + profile-on-file flag."""
    return {
        "caller_lat": session.get("caller_lat"),
        "caller_lng": session.get("caller_lng"),
        "location_name": session.get("location_name"),
        "category": session.get("category"),
        "disaster_type": session.get("disaster_type"),
        "disaster_severity": session.get("disaster_severity"),
        "has_profile": bool(session.get("caller_profile")),
    }


def _render_call_transcript(history: List[Dict[str, Any]]) -> str:
    """Readable Caller/Operator transcript of the whole call, stored on the call
    record so responders can read the full exchange behind the concise summary."""
    lines = []
    for turn in history:
        text = (turn.get("text") or "").strip()
        if not text:
            continue
        who = "Operator" if turn.get("role") == "operator" else "Caller"
        lines.append(f"{who}: {text}")
    return "\n".join(lines)


def _db_upsert_operator_log(session: Dict[str, Any]) -> None:
    """Persist/refresh the audit row for one operator call session. Best-effort —
    audit logging must NEVER break a live 911 call."""
    try:
        plan = session.get("plan", {})
        conn = psycopg2.connect(DATABASE_URL)
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO operator_call_logs
                            (session_id, call_id, citizen_id, citizen_name, started_at,
                             updated_at, caller_lat, caller_lng, location_name,
                             conversation, summary, services, severity, category, ended)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (session_id) DO UPDATE SET
                            call_id = EXCLUDED.call_id,
                            updated_at = EXCLUDED.updated_at,
                            conversation = EXCLUDED.conversation,
                            summary = EXCLUDED.summary,
                            services = EXCLUDED.services,
                            severity = EXCLUDED.severity,
                            category = EXCLUDED.category,
                            ended = EXCLUDED.ended;
                        """,
                        (
                            session["id"],
                            session.get("call_id"),
                            session.get("citizen_id"),
                            session.get("citizen_name"),
                            session.get("started_at"),
                            datetime.utcnow(),
                            session.get("caller_lat"),
                            session.get("caller_lng"),
                            session.get("location_name"),
                            psycopg2.extras.Json(session.get("history") or []),
                            session.get("summary"),
                            psycopg2.extras.Json(plan.get("services") or []),
                            plan.get("severity"),
                            plan.get("category"),
                            bool(session.get("ended")),
                        ),
                    )
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - audit must not break the call
        logging.getLogger("sentinel.operator").warning("audit log upsert failed: %s", exc)


def _lookup_disaster_brief(disaster_id: Optional[str]) -> Tuple[Optional[str], Optional[int]]:
    """Best-effort (type, severity) for an optional disaster context. Never raises."""
    if not disaster_id:
        return None, None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT disaster_type, severity FROM disaster_events WHERE id = %s;",
                        (disaster_id,),
                    )
                    row = cur.fetchone()
        finally:
            conn.close()
        if row:
            return row[0], row[1]
    except Exception:  # noqa: BLE001
        pass
    return None, None


class OperatorStartPayload(BaseModel):
    """Open a live AI-operator call session."""
    citizen_id: str
    caller_lat: float
    caller_lng: float
    # Reverse-geocoded place name for the caller's location (powers the
    # "my location / current location / my area" shortcut, so the caller never
    # has to read out coordinates).
    location_name: Optional[str] = None
    category: Optional[str] = None
    disaster_id: Optional[str] = None
    caller_profile: Optional[Dict[str, Any]] = None


class OperatorMessagePayload(BaseModel):
    """One caller turn — typed text OR a spoken-audio clip to transcribe."""
    session_id: str
    text: Optional[str] = None
    audio_base64: Optional[str] = None
    mime: Optional[str] = None


class OperatorEndPayload(BaseModel):
    """End the call: finalize a concise brief and dispatch the responders."""
    session_id: str
    idempotency_key: Optional[str] = None
    photo_data_url: Optional[str] = None


class OperatorTranscribePayload(BaseModel):
    """Transcribe a spoken clip to text WITHOUT sending it to the operator, so the
    caller can review/edit the words before they send the message."""
    audio_base64: str
    mime: Optional[str] = None
    session_id: Optional[str] = None


@app.post("/api/911/operator/start", tags=["911"])
def operator_start(payload: OperatorStartPayload):
    """Begin a conversational 911 call. Returns the session id + the operator's
    opening line. The caller then exchanges messages via /operator/message and
    hangs up via /operator/end."""
    _rate_limit(f"operator:{payload.citizen_id}", max_events=20, window_s=60.0)
    with _mobile_lock:
        citizen = MOBILE_CITIZENS.get(payload.citizen_id)
    if citizen is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Citizen not found — sign in again.")

    from pipeline.operator import GREETING
    disaster_type, disaster_severity = _lookup_disaster_brief(payload.disaster_id)
    sid = str(uuid.uuid4())
    session = {
        "id": sid,
        "citizen_id": payload.citizen_id,
        "citizen_name": citizen.get("name") or "Unknown caller",
        "caller_lat": payload.caller_lat,
        "caller_lng": payload.caller_lng,
        "location_name": (payload.location_name or None),
        "category": (payload.category or None),
        "disaster_id": (payload.disaster_id or None),
        "disaster_type": disaster_type,
        "disaster_severity": disaster_severity,
        "caller_profile": (payload.caller_profile or None),
        "history": [{"role": "operator", "text": GREETING, "ts": _now_iso()}],
        "plan": {"services": [], "severity": 3, "category": (payload.category or "Other")},
        "started_at": datetime.utcnow(),
        "ended": False,
        "call_id": None,
        "summary": None,
        "_touched": time.monotonic(),
    }
    with _operator_lock:
        _prune_operator_sessions()
        OPERATOR_SESSIONS[sid] = session
    _db_upsert_operator_log(session)
    return {"session_id": sid, "greeting": GREETING}


@app.post("/api/911/operator/message", tags=["911"])
def operator_message(payload: OperatorMessagePayload):
    """One conversational turn. Accepts typed text or a spoken-audio clip (which
    is transcribed server-side). Returns the operator's reply + its current
    dispatch plan (services/severity/category). The exchange is appended to the
    audit log every turn."""
    with _operator_lock:
        session = OPERATOR_SESSIONS.get(payload.session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call session not found or expired — start a new call.")
    if session.get("ended"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This call has already ended.")
    _rate_limit(f"operator:{session['citizen_id']}", max_events=40, window_s=60.0)

    from pipeline import operator as op

    plan = session["plan"]
    # 1. Resolve the caller's words — transcribe audio when there's no text.
    user_text = (payload.text or "").strip()
    transcription_failed = False
    if not user_text and payload.audio_base64:
        res = op.transcribe_audio(payload.audio_base64, payload.mime)
        user_text = (res.get("text") or "").strip()
        transcription_failed = not user_text
    if not user_text:
        # Nothing intelligible — a calm reprompt, no model call, no history churn.
        return {
            "user_text": "",
            "reply": "I didn't catch that — could you say it again, or type what's happening?",
            "services": plan["services"], "severity": plan["severity"], "category": plan["category"],
            "ready_to_dispatch": False, "off_topic": False, "transcription_failed": transcription_failed,
        }

    # 2. Append the caller turn, ask the operator for its reply + plan.
    session["history"].append({"role": "caller", "text": user_text, "ts": _now_iso()})
    turn = op.operator_turn(session["history"], _operator_ctx(session))

    # 3. Merge the plan — only adopt a non-empty service set so we never regress
    #    to "no responders" mid-call once we've learned what's needed.
    if turn.get("services"):
        plan["services"] = turn["services"]
    plan["severity"] = turn.get("severity", plan["severity"])
    plan["category"] = turn.get("category", plan["category"])

    # 4. Append the operator reply + persist the audit log for this turn.
    session["history"].append({"role": "operator", "text": turn["reply"], "ts": _now_iso()})
    session["_touched"] = time.monotonic()
    _db_upsert_operator_log(session)
    return {
        "user_text": user_text,
        "reply": turn["reply"],
        "services": plan["services"],
        "severity": plan["severity"],
        "category": plan["category"],
        "ready_to_dispatch": turn.get("ready_to_dispatch", False),
        "off_topic": turn.get("off_topic", False),
        "transcription_failed": False,
    }


@app.post("/api/911/operator/transcribe", tags=["911"])
def operator_transcribe(payload: OperatorTranscribePayload):
    """Speech-to-text for ONE spoken clip — returns the text so the caller can
    review it in the input box before sending. Does not touch the conversation."""
    cid = "anon"
    if payload.session_id:
        with _operator_lock:
            sess = OPERATOR_SESSIONS.get(payload.session_id)
        if sess:
            cid = sess.get("citizen_id") or "anon"
    _rate_limit(f"operator-stt:{cid}", max_events=60, window_s=60.0)
    from pipeline import operator as op
    res = op.transcribe_audio(payload.audio_base64, payload.mime)
    text = res.get("text", "")
    return {"text": text, "transcription_failed": not text}


@app.post("/api/911/operator/end", tags=["911"])
def operator_end(payload: OperatorEndPayload, background_tasks: BackgroundTasks):
    """Hang up: generate the concise dispatch brief, dispatch the responders, and
    finalize the audit log. Idempotent — re-ending returns the same dispatched
    call instead of double-dispatching."""
    with _operator_lock:
        session = OPERATOR_SESSIONS.get(payload.session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call session not found or expired.")
    # Idempotent: already dispatched → return the same call.
    if session.get("ended") and session.get("call_id"):
        existing = _db_get_call(session["call_id"])
        if existing:
            return {"call": existing, "summary": session.get("summary"), "key_facts": session.get("key_facts", [])}

    from pipeline import operator as op

    final = op.finalize_call(session["history"], _operator_ctx(session))
    services = final.get("services") or session["plan"].get("services") or list(op.SERVICES)
    summary = final.get("summary")
    transcript = _render_call_transcript(session["history"])
    idem = payload.idempotency_key or f"operator:{session['id']}"

    call = _place_emergency_call(
        citizen_id=session["citizen_id"],
        caller_lat=session["caller_lat"],
        caller_lng=session["caller_lng"],
        requested_services=services,
        transcript=transcript,
        background_tasks=background_tasks,
        disaster_id=session.get("disaster_id"),
        category=final.get("category") or session.get("category"),
        photo_data_url=payload.photo_data_url,
        idempotency_key=idem,
        caller_profile=session.get("caller_profile"),
        summary=summary,
        severity_override=final.get("severity"),
    )

    # Finalize the session + audit row.
    session["ended"] = True
    session["call_id"] = call.get("id")
    session["summary"] = summary
    session["key_facts"] = final.get("key_facts", [])
    session["plan"]["services"] = services
    session["plan"]["severity"] = final.get("severity", session["plan"]["severity"])
    session["plan"]["category"] = final.get("category", session["plan"]["category"])
    session["_touched"] = time.monotonic()
    _db_upsert_operator_log(session)
    return {"call": call, "summary": summary, "key_facts": final.get("key_facts", [])}


@app.get("/api/911/operator/logs", tags=["911"])
def list_operator_logs(limit: int = Query(100, ge=1, le=500)):
    """Audit feed of AI-operator call conversations (caller chat + operator
    replies + the final summary), newest first. For admin / compliance review."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT session_id, call_id, citizen_id, citizen_name, started_at,
                           updated_at, caller_lat, caller_lng, location_name,
                           conversation, summary, services, severity, category, ended
                    FROM operator_call_logs ORDER BY updated_at DESC LIMIT %s;
                    """,
                    (limit,),
                )
                rows = cur.fetchall()
    finally:
        conn.close()
    cols = [
        "session_id", "call_id", "citizen_id", "citizen_name", "started_at", "updated_at",
        "caller_lat", "caller_lng", "location_name", "conversation", "summary", "services",
        "severity", "category", "ended",
    ]
    out = []
    for r in rows:
        d: Dict[str, Any] = {}
        for c, v in zip(cols, r):
            if c in ("started_at", "updated_at") and v is not None and hasattr(v, "isoformat"):
                v = v.isoformat()
            if c == "call_id" and v is not None:
                v = str(v)
            d[c] = v
        out.append(d)
    return {"logs": out}


# ════════════════════════════════════════════════════════════════════
# Admin: dispatch roster + AI agents + savings summary
# ════════════════════════════════════════════════════════════════════

# Replace static MOCK_AGENTS with mutable registry
AGENT_REGISTRY: List[Dict[str, Any]] = [
    {
        "id": "agent-sentinel-core",
        "name": "Sentinel Core",
        "role": "Master orchestrator — detection, triage, and response coordination",
        "model": "gemini-2.5-flash",
        "status": "initializing",
        "last_action": "Starting up...",
        "metrics": {"detection_sweeps": 0, "incidents_declared": 0, "dispatches": 0},
    },
    {
        "id": "agent-incident-monitor",
        "name": "Incident Monitor",
        "role": "Active incident tracking, trajectory prediction, response adaptation",
        "model": "gemini-2.5-flash",
        "status": "idle",
        "last_action": "Waiting for active incidents...",
        "metrics": {"incidents_monitored": 0, "patches_issued": 0, "recalls": 0},
    },
    {
        "id": "agent-triage",
        "name": "Crisis Triage",
        "role": "Multi-crisis resource allocation and harm-avoided optimization",
        "model": "gemini-2.5-flash",
        "status": "idle",
        "last_action": "No competing incidents",
        "metrics": {"triage_decisions": 0, "units_reallocated": 0},
    },
    {
        "id": "agent-credibility",
        "name": "Signal Analyst",
        "role": "Source credibility scoring, prank filtering, triangulation",
        "model": "gemini-2.5-flash",
        "status": "online",
        "last_action": "Monitoring signal feeds...",
        "metrics": {"reports_scored": 0, "pranks_filtered": 0, "false_alarms_caught": 0},
    },
]


@app.get("/api/agents", tags=["Admin"])
def list_agents():
    """Mock AI agent roster. Will be replaced by live model status when
    the real agents come online."""
    return {"agents": AGENT_REGISTRY}


@app.get("/api/agents/{agent_id}", tags=["Admin"])
def get_agent(agent_id: str):
    for agent in AGENT_REGISTRY:
        if agent["id"] == agent_id:
            return agent
    raise HTTPException(status_code=404, detail="Agent not found.")


@app.patch("/api/agents/{agent_id}", tags=["Admin"])
def update_agent(agent_id: str, update: Dict[str, Any]):
    """Orchestrator updates its own agent status."""
    for agent in AGENT_REGISTRY:
        if agent["id"] == agent_id:
            for k in ("status", "last_action", "metrics"):
                if k in update:
                    agent[k] = update[k]
            return {"success": True}
    raise HTTPException(status_code=404, detail="Agent not found.")


# ════════════════════════════════════════════════════════════════════
# Admin: City Resilience Heatmap + AI insight
#
# Two spatial layers for the mobile admin "Impact" view:
#   • casualties — every responder casualty report (all statuses, all-time),
#     weighted by kind (critical > fainted > injured) × severity. The app has
#     no explicit "death" field, so critical (life-threatening) casualties are
#     the proxy for the worst outcomes; the layer is labelled "Casualties".
#   • damage — each disaster reduced to its centroid, weighted by severity
#     blended with a log-scaled at-risk proxy (people_inside × unsafe-exit %).
#
# Raw weights + max_weight are returned; the mobile client normalises so a lone
# point is never invisible. /api/city-insight reuses the same aggregate. Both
# are admin-only via the mobile nav (client-side, like the other admin
# endpoints) and never 500 on empty data.
# ════════════════════════════════════════════════════════════════════

_heat_log = logging.getLogger("sentinel.heatmap")

# Per-kind casualty weights. critical (life-threatening) dominates — it's the
# closest stand-in for a fatality. Severity (1-10, nullable) scales within a
# kind; a floor keeps a severity-null row visible.
_CASUALTY_KIND_WEIGHT = {
    "casualty_critical": 1.0,
    "casualty_fainted": 0.6,
    "casualty_injured": 0.45,
}
_CASUALTY_SEVERITY_FLOOR = 0.35


def _casualty_heat_points() -> Tuple[List[List[float]], Dict[str, int]]:
    """All-time casualty responder reports → weighted [lat, lng, w] points.
    Returns (points, by_kind counts). Never raises — ([], zeros) on error."""
    points: List[List[float]] = []
    by_kind: Dict[str, int] = {"critical": 0, "fainted": 0, "injured": 0}
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # No status filter (the /api/responder-reports default of
                # 'pending' would hide resolved history). Filter to casualty_*
                # in SQL; validate the lat/lng in Python so we don't depend on
                # the JSONB '?' operator / column type.
                cur.execute(
                    """
                    SELECT report_kind, location, severity
                    FROM responder_reports
                    WHERE report_kind LIKE 'casualty_%';
                    """
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        _heat_log.warning("city-heatmap casualties read failed: %s", exc)
        return [], by_kind

    for kind, location, severity in rows:
        loc = _coerce_geojson(location) or {}
        try:
            lat = float(loc["lat"])
            lng = float(loc["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        kind_w = _CASUALTY_KIND_WEIGHT.get(kind, 0.4)
        sev_scale = (
            max(_CASUALTY_SEVERITY_FLOOR, float(severity) / 10.0)
            if severity is not None
            else 0.6
        )
        points.append([lat, lng, round(kind_w * sev_scale, 4)])
        short = kind.replace("casualty_", "")
        if short in by_kind:
            by_kind[short] += 1
    return points, by_kind


def _damage_heat_points() -> Tuple[List[List[float]], int, int]:
    """Disasters (active + cleared) → centroid points weighted by severity blended
    with a log-scaled at-risk proxy. Returns (points, total_est_at_risk, count).
    Never raises — ([], 0, 0) on error."""
    points: List[List[float]] = []
    total_est = 0.0
    count = 0
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                geom_expr = _geometry_select_expr(cur)
                cur.execute(
                    f"""
                    SELECT severity, {geom_expr}, people_inside, safe_exit_pct, status
                    FROM disaster_events
                    WHERE status IN ('active', 'cleared');
                    """
                )
                rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        _heat_log.warning("city-heatmap damage read failed: %s", exc)
        return [], 0, 0

    for severity, geom, people_inside, safe_exit_pct, status_val in rows:
        centroid = _geometry_centroid(geom)
        if not centroid:
            continue
        est = 0.0
        if people_inside is not None and safe_exit_pct is not None:
            try:
                est = max(0.0, float(people_inside) * (1.0 - float(safe_exit_pct) / 100.0))
            except (TypeError, ValueError):
                est = 0.0
        total_est += est
        sev_term = float(severity or 0) / 10.0
        people_term = (math.log1p(est) / math.log1p(150.0)) if est > 0 else 0.0
        w = 0.6 * sev_term + 0.4 * min(1.0, people_term)
        if status_val == "cleared":
            w *= 0.6  # historical, not current — de-emphasise
        points.append([centroid["lat"], centroid["lng"], round(max(0.1, w), 4)])
        count += 1
    return points, int(round(total_est)), count


@app.get("/api/city-heatmap", tags=["Admin"])
def city_heatmap():
    """Admin-only spatial aggregate powering the mobile 'City Resilience Heatmap'.

    Two layers — casualties (responder reports, all-time) and damage (disasters
    reduced to centroids). Raw weights + max_weight per layer; the client
    normalises. Admin-only is enforced client-side (mobile nav), consistent with
    the other /api admin endpoints. Returns empty arrays (never 500) on no data."""
    cas_points, by_kind = _casualty_heat_points()
    dmg_points, total_est, dmg_count = _damage_heat_points()
    return {
        "casualties": {
            "points": cas_points,
            "max_weight": max((p[2] for p in cas_points), default=1.0),
            "count": len(cas_points),
            "by_kind": by_kind,
        },
        "damage": {
            "points": dmg_points,
            "max_weight": max((p[2] for p in dmg_points), default=1.0),
            "count": dmg_count,
            "total_est_fatalities": total_est,
        },
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }


# ── Grounding for /api/city-insight ──────────────────────────────────
# The geographic math (clustering, nearest-service distances) is done here in
# Python — LLMs are unreliable at it — and handed to Gemini as plain numbers so
# it can write recommendations like "add a clinic near the Midtown cluster —
# 4.2 km to the nearest hospital".

def _cluster_points(points: List[List[float]], *, cell_deg: float, top_n: int) -> List[Dict[str, Any]]:
    """Grid-bucket weighted [lat,lng,w] points (~cell_deg square) and return the
    top_n buckets by summed weight, each as {lat, lng, count, weight} with a
    weight-weighted centroid."""
    buckets: Dict[Tuple[int, int], Dict[str, float]] = {}
    for lat, lng, w in points:
        key = (int(round(lat / cell_deg)), int(round(lng / cell_deg)))
        b = buckets.setdefault(key, {"wsum": 0.0, "latw": 0.0, "lngw": 0.0, "count": 0.0})
        b["wsum"] += w
        b["latw"] += lat * w
        b["lngw"] += lng * w
        b["count"] += 1
    out: List[Dict[str, Any]] = []
    for b in buckets.values():
        if b["wsum"] <= 0:
            continue
        out.append({
            "lat": round(b["latw"] / b["wsum"], 5),
            "lng": round(b["lngw"] / b["wsum"], 5),
            "count": int(b["count"]),
            "weight": round(b["wsum"], 3),
        })
    out.sort(key=lambda c: c["weight"], reverse=True)
    return out[:top_n]


def _nearest_summary(lat: float, lng: float) -> Dict[str, Any]:
    """Nearest hospital / fire / police {name, distance_m} for a hotspot."""
    out: Dict[str, Any] = {}
    for kind in ("hospital", "fire_station", "police_station"):
        near = _nearest_resources(lat, lng, kind, limit=1)
        out[kind] = {"name": near[0]["name"], "distance_m": near[0]["distance_m"]} if near else None
    return out


def _load_all_stations() -> Dict[str, List[Tuple[str, float, float]]]:
    """Every hospital / fire / police station in a SINGLE connection, as
    {kind: [(name, lat, lng), ...]}. Replaces the per-cluster, per-kind
    _nearest_resources fan-out (which opened ~24 remote connections per insight
    build — the dominant cold-start latency). Never raises — empty on error."""
    out: Dict[str, List[Tuple[str, float, float]]] = {
        "hospital": [], "fire_station": [], "police_station": [],
    }
    tables = {"hospital": "hospitals", "fire_station": "fire_stations", "police_station": "police_stations"}
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                for kind, table in tables.items():
                    cur.execute(f"SELECT name, lat, lng FROM {table};")
                    out[kind] = [(r[0], float(r[1]), float(r[2])) for r in cur.fetchall()]
        conn.close()
    except Exception as exc:
        _heat_log.warning("insight station load failed: %s", exc)
    return out


def _nearest_summary_from(
    stations: Dict[str, List[Tuple[str, float, float]]], lat: float, lng: float
) -> Dict[str, Any]:
    """Nearest hospital / fire / police {name, distance_m} for a hotspot, computed
    in Python from preloaded stations (no DB hit)."""
    out: Dict[str, Any] = {}
    for kind in ("hospital", "fire_station", "police_station"):
        best_name, best_d = None, None
        for name, slat, slng in stations.get(kind, []):
            d = _distance_haversine(lat, lng, slat, slng)
            if best_d is None or d < best_d:
                best_name, best_d = name, d
        out[kind] = {"name": best_name, "distance_m": round(best_d, 1)} if best_name is not None else None
    return out


# Neighbourhood centroids for turning a hotspot lat/lng into a human-readable
# area name ("Washington Heights") instead of raw coordinates in the AI insight.
# Offline + deterministic (no geocoding API). Manhattan-dense (the demo's focus)
# with a few outer-borough anchors so a stray point still resolves to something
# sensible. A hotspot farther than _NEIGHBORHOOD_MAX_M from all of these falls
# back to coordinates.
_NEIGHBORHOODS: List[Tuple[str, float, float]] = [
    ("Financial District", 40.7075, -74.0113), ("Battery Park City", 40.7115, -74.0156),
    ("Tribeca", 40.7163, -74.0086), ("SoHo", 40.7233, -74.0030),
    ("Chinatown", 40.7158, -73.9970), ("Lower East Side", 40.7150, -73.9843),
    ("East Village", 40.7265, -73.9815), ("Greenwich Village", 40.7336, -74.0027),
    ("West Village", 40.7358, -74.0036), ("Chelsea", 40.7465, -74.0014),
    ("Flatiron", 40.7401, -73.9903), ("Gramercy", 40.7368, -73.9845),
    ("Murray Hill", 40.7479, -73.9756), ("Midtown", 40.7549, -73.9840),
    ("Midtown East", 40.7549, -73.9719), ("Hell's Kitchen", 40.7638, -73.9918),
    ("Times Square", 40.7580, -73.9855), ("Central Park", 40.7829, -73.9654),
    ("Upper East Side", 40.7736, -73.9566), ("Upper West Side", 40.7870, -73.9754),
    ("Lincoln Square", 40.7741, -73.9846), ("Roosevelt Island", 40.7610, -73.9505),
    ("Morningside Heights", 40.8089, -73.9626), ("East Harlem", 40.7957, -73.9389),
    ("Harlem", 40.8116, -73.9465), ("Hamilton Heights", 40.8252, -73.9493),
    ("Washington Heights", 40.8417, -73.9393), ("Inwood", 40.8677, -73.9212),
    # Outer-borough anchors (fallback only).
    ("Long Island City", 40.7447, -73.9485), ("Astoria", 40.7644, -73.9235),
    ("Williamsburg", 40.7081, -73.9571), ("DUMBO", 40.7033, -73.9881),
    ("Downtown Brooklyn", 40.6920, -73.9890), ("South Bronx", 40.8200, -73.9100),
    ("St. George, Staten Island", 40.6440, -74.0760),
]
_NEIGHBORHOOD_MAX_M = 3000.0


def _nearest_neighborhood(lat: float, lng: float) -> Optional[str]:
    """Human-readable area name for a hotspot, or None if nothing is close
    enough (caller falls back to coordinates)."""
    best_name, best_d = None, _NEIGHBORHOOD_MAX_M
    for name, nlat, nlng in _NEIGHBORHOODS:
        d = _distance_haversine(lat, lng, nlat, nlng)
        if d < best_d:
            best_name, best_d = name, d
    return best_name


def _build_insight_stats() -> Dict[str, Any]:
    """Precompute the grounded spatial summary the insight model reasons over."""
    cas_points, by_kind = _casualty_heat_points()
    dmg_points, total_est, dmg_count = _damage_heat_points()
    # ~0.005° ≈ 500 m at NYC latitude.
    cas_clusters = _cluster_points(cas_points, cell_deg=0.005, top_n=5)
    dmg_clusters = _cluster_points(dmg_points, cell_deg=0.005, top_n=3)
    stations = _load_all_stations()  # one connection, reused for every cluster
    for c in cas_clusters + dmg_clusters:
        c["nearest"] = _nearest_summary_from(stations, c["lat"], c["lng"])
        # Human-readable label the AI should cite instead of coordinates.
        c["area"] = _nearest_neighborhood(c["lat"], c["lng"]) or f"({c['lat']:.4f}, {c['lng']:.4f})"
    return {
        "totals": {
            "casualty_reports": len(cas_points),
            "casualty_by_kind": by_kind,
            "damage_zones": dmg_count,
            "estimated_at_risk_people": total_est,
        },
        "top_casualty_clusters": cas_clusters,
        "worst_damage_zones": dmg_clusters,
        "note": (
            "Each cluster has an 'area' field — a human-readable neighbourhood name. "
            "ALWAYS refer to hotspots by their 'area' name (e.g. 'Washington Heights'), "
            "never by raw lat/lng coordinates. distance_m values are metres to the "
            "nearest existing service. Casualty 'weight' blends report count with "
            "severity (critical weighted highest). The city keeps no explicit fatality "
            "records; critical casualties are the proxy for the most severe outcomes."
        ),
    }


# ── Durable insight store ────────────────────────────────────────────
# Generated insights are persisted to Postgres so they survive a backend
# restart AND so a transient Vertex failure can fall back to the last good
# insight instead of an empty "unavailable" card. Keyed by a hash of the
# heatmap stats, so an unchanged city state reuses the stored row.
_city_insight_log = logging.getLogger("sentinel.city_insight_store")
_CITY_INSIGHT_TABLE_READY = False
# How long a stored/cached insight is considered fresh enough to serve without
# regenerating. The underlying heatmap only changes as incidents land, and the
# cache key is a hash of the heat points — so a genuine change regenerates
# regardless. A generous window keeps re-opens instant and rare cold rebuilds.
_CITY_INSIGHT_TTL_S = float(os.environ.get("SENTINEL_CITY_INSIGHT_CACHE_TTL", "600.0"))
# Process-local hot cache: {signature -> (payload, monotonic_at)}. Lets a repeat
# request skip even the cheap DB round-trip.
_CITY_INSIGHT_MEM: Dict[str, Any] = {"key": None, "at": 0.0, "value": None}


def _heatmap_signature(cas_points: List[List[float]], dmg_points: List[List[float]]) -> str:
    """Cheap, order-stable hash of the raw heat points. Identical points => same
    signature => reuse the stored insight without rebuilding stats or calling the
    model. Computed from the two cheap point queries, NOT the ~24 nearest-service
    queries that _build_insight_stats fires."""
    try:
        raw = json.dumps(
            [sorted(list(p) for p in cas_points), sorted(list(p) for p in dmg_points)],
            default=str,
        )
    except Exception:  # noqa: BLE001
        raw = repr((len(cas_points), len(dmg_points)))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _ensure_city_insight_table(cur) -> None:
    global _CITY_INSIGHT_TABLE_READY
    if _CITY_INSIGHT_TABLE_READY:
        return
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS city_insights (
            stats_key  TEXT PRIMARY KEY,
            payload    JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    _CITY_INSIGHT_TABLE_READY = True


def _store_city_insight(stats_key: Optional[str], payload: Dict[str, Any]) -> None:
    """Persist the latest good insight for a heatmap state. Best-effort; never raises."""
    if not stats_key:
        return
    clean = {k: v for k, v in payload.items() if k != "cached"}
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                _ensure_city_insight_table(cur)
                cur.execute(
                    """
                    INSERT INTO city_insights (stats_key, payload, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (stats_key)
                    DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();
                    """,
                    (stats_key, json.dumps(clean)),
                )
        conn.close()
    except Exception as exc:  # noqa: BLE001 - persistence is best-effort
        _city_insight_log.warning("store failed: %s", exc)


def _load_city_insight(stats_key: Optional[str]) -> Tuple[Optional[Dict[str, Any]], Optional[float]]:
    """Best stored insight as (payload, age_seconds): an exact stats_key match if
    present, else the most-recently-updated of any. (None, None) if nothing/err."""
    payload: Optional[Dict[str, Any]] = None
    age: Optional[float] = None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                _ensure_city_insight_table(cur)
                if stats_key:
                    cur.execute(
                        "SELECT payload, EXTRACT(EPOCH FROM (NOW() - updated_at)) "
                        "FROM city_insights WHERE stats_key = %s;",
                        (stats_key,),
                    )
                    row = cur.fetchone()
                    if row:
                        payload, age = row[0], float(row[1])
                if payload is None:
                    cur.execute(
                        "SELECT payload, EXTRACT(EPOCH FROM (NOW() - updated_at)) "
                        "FROM city_insights ORDER BY updated_at DESC LIMIT 1;"
                    )
                    row = cur.fetchone()
                    if row:
                        payload, age = row[0], float(row[1])
        conn.close()
    except Exception as exc:  # noqa: BLE001 - fallback read is best-effort
        _city_insight_log.warning("load failed: %s", exc)
    return payload, age


@app.get("/api/city-insight", tags=["Admin"])
def city_insight():
    """Admin-only: a real, Gemini-generated city-resilience insight grounded in the
    /api/city-heatmap aggregate (top casualty clusters, worst damage zones, and the
    distance from each to the nearest hospital/fire/police station). Never 500s.

    Persisted to Postgres: a freshly generated insight is stored, and if live
    generation is unavailable we serve the last good stored insight (flagged
    `stale`) so the admin still sees real recommendations rather than an empty
    card. Unlike /api/savings-summary/insight, the narrative is generated live."""
    from pipeline.city_insight import generate_insight

    # Cheap first: just the two heat-point queries (no nearest-service fan-out).
    cas_points, _by_kind = _casualty_heat_points()
    dmg_points, _total_est, _dmg_count = _damage_heat_points()
    sig = _heatmap_signature(cas_points, dmg_points)
    now = time.monotonic()

    # 1) Process-local hot cache — instant.
    mem = _CITY_INSIGHT_MEM
    if mem.get("key") == sig and mem.get("value") and (now - mem["at"]) < _CITY_INSIGHT_TTL_S:
        return mem["value"]

    # 2) Durable store — fresh row for this exact heatmap state (survives restart).
    payload, age = _load_city_insight(sig)
    if payload and age is not None and age < _CITY_INSIGHT_TTL_S:
        _CITY_INSIGHT_MEM.update({"key": sig, "at": now, "value": payload})
        return payload

    # 3) Miss → build the full grounded stats (the expensive part) and generate.
    result = generate_insight(_build_insight_stats())
    if result.get("status") == "done":
        result.pop("cached", None)
        _store_city_insight(sig, result)
        _CITY_INSIGHT_MEM.update({"key": sig, "at": now, "value": result})
        return result

    # 4) Generation unavailable → serve the last good stored insight (any), stale-flagged.
    if result.get("status") == "unavailable" and payload:
        stale = dict(payload)
        stale["stale"] = True
        stale["stale_age_seconds"] = int(age) if age is not None else None
        return stale

    return result


# ── Admin savings tiles — derived from real event history ─────────────
# The three headline numbers are computed from live DB tables (resolved
# casualties, handled-disaster severity, dispatched units), not a hardcoded
# ticker. The per-unit USD figures below are domain-assumption ESTIMATION
# FACTORS (like _CASUALTY_KIND_WEIGHT) — they convert raw real counts into a
# dashboard headline; they are not measured dollars.
_STRUCTURE_VALUE_PER_SEVERITY_USD = 750_000  # structure value exposed per severity point of a handled disaster
_OPS_SAVINGS_PER_UNIT_USD = 4_200            # operational $ saved per unit by pre-positioning vs reactive dispatch

_savings_log = logging.getLogger("sentinel.savings")


def _compute_savings() -> Dict[str, Any]:
    """Real, DB-derived figures for the admin savings tiles. Never raises —
    returns zeros on any DB error (advisory dashboard, must never 500)."""
    lives = infra_usd = money_usd = 0
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                # lives_saved: casualties a responder unit was actually dispatched
                # to (the report is marked 'resolved' on auto-dispatch).
                cur.execute(
                    "SELECT COUNT(*) FROM responder_reports "
                    "WHERE report_kind LIKE 'casualty_%' AND status = 'resolved';"
                )
                lives = int(cur.fetchone()[0] or 0)
                # infrastructure_value_usd: structure value tied up in disasters the
                # platform is handling (active + cleared), scaled by total severity.
                cur.execute(
                    "SELECT COALESCE(SUM(severity), 0) FROM disaster_events "
                    "WHERE status IN ('active', 'cleared');"
                )
                infra_usd = int(cur.fetchone()[0] or 0) * _STRUCTURE_VALUE_PER_SEVERITY_USD
                # money_saved_usd: operational savings across every dispatched
                # unit. Two real sources of dispatched units: AI/operator HTTP
                # dispatches (active_dispatches rows) and the casualty auto-
                # dispatch path (one ambulance per resolved casualty report,
                # which is exactly `lives`).
                cur.execute(
                    "SELECT COALESCE(SUM(unit_count), 0) FROM active_dispatches "
                    "WHERE status IN ('active', 'completed');"
                )
                dispatched_units = int(cur.fetchone()[0] or 0) + lives
                money_usd = dispatched_units * _OPS_SAVINGS_PER_UNIT_USD
        conn.close()
    except Exception as exc:
        _savings_log.warning("savings compute failed: %s", exc)
    return {
        "lives_saved": lives,
        "infrastructure_value_usd": infra_usd,
        "money_saved_usd": money_usd,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


def _savings_breakdown() -> Dict[str, int]:
    """Raw real counts the savings narratives are grounded in. Never raises —
    returns zeros for anything it can't read."""
    out = {
        "casualties_total": 0, "casualties_resolved": 0, "casualties_pending": 0,
        "disasters_active": 0, "disasters_cleared": 0, "severity_sum": 0,
        "dispatch_units": 0, "dispatches_completed": 0, "auto_ambulances": 0,
        "ambulance_capacity": 0, "truck_capacity": 0,
    }
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status, COUNT(*) FROM responder_reports "
                    "WHERE report_kind LIKE 'casualty_%' GROUP BY status;"
                )
                for st, n in cur.fetchall():
                    out["casualties_total"] += int(n)
                    if st == "resolved":
                        out["casualties_resolved"] = int(n)
                    elif st == "pending":
                        out["casualties_pending"] = int(n)
                cur.execute(
                    "SELECT status, COUNT(*), COALESCE(SUM(severity), 0) "
                    "FROM disaster_events WHERE status IN ('active', 'cleared') GROUP BY status;"
                )
                for st, n, sev in cur.fetchall():
                    out["severity_sum"] += int(sev)
                    if st == "active":
                        out["disasters_active"] = int(n)
                    elif st == "cleared":
                        out["disasters_cleared"] = int(n)
                cur.execute(
                    "SELECT COALESCE(SUM(unit_count), 0), "
                    "COUNT(*) FILTER (WHERE status = 'completed') "
                    "FROM active_dispatches WHERE status IN ('active', 'completed');"
                )
                units, completed = cur.fetchone()
                out["dispatches_completed"] = int(completed or 0)
                # One ambulance is auto-dispatched per resolved casualty; count
                # those toward total dispatched units alongside HTTP dispatches.
                out["auto_ambulances"] = out["casualties_resolved"]
                out["dispatch_units"] = int(units or 0) + out["casualties_resolved"]
                cur.execute("SELECT COALESCE(SUM(ambulance_count), 0) FROM hospitals;")
                out["ambulance_capacity"] = int(cur.fetchone()[0] or 0)
                cur.execute("SELECT COALESCE(SUM(truck_count), 0) FROM fire_stations;")
                out["truck_capacity"] = int(cur.fetchone()[0] or 0)
        conn.close()
    except Exception as exc:
        _savings_log.warning("savings breakdown failed: %s", exc)
    return out


def _savings_insight(metric: str) -> Optional[Dict[str, Any]]:
    """Build a savings-tile narrative grounded in live event-history counts.
    Returns None for an unknown metric. Deterministic — no LLM call."""
    s = _compute_savings()
    b = _savings_breakdown()
    if metric == "lives":
        reached = b["casualties_resolved"]
        tail = (
            f"{b['casualties_pending']:,} report(s) are still pending a unit."
            if b["casualties_pending"]
            else "Every recorded casualty has been reached."
        )
        return {
            "title": f"{s['lives_saved']:,} casualties reached by a dispatched responder",
            "summary": (
                f"Responders filed {b['casualties_total']:,} casualty report(s) in the field; "
                f"{reached:,} were resolved by an ambulance auto-dispatched from the nearest "
                f"hospital with capacity. {tail}"
            ),
            "highlights": [
                f"Casualty reports filed: {b['casualties_total']:,}",
                f"Reached by a dispatched unit: {reached:,}",
                f"Still pending: {b['casualties_pending']:,}",
                f"Ambulance capacity on the map: {b['ambulance_capacity']:,}",
            ],
        }
    if metric == "infrastructure":
        return {
            "title": f"${s['infrastructure_value_usd'] / 1e6:.1f}M in infrastructure under active protection",
            "summary": (
                f"{b['disasters_active']:,} active and {b['disasters_cleared']:,} cleared disaster(s) "
                f"carry a combined severity of {b['severity_sum']:,}. At an estimated "
                f"${_STRUCTURE_VALUE_PER_SEVERITY_USD:,} of structure value per severity point, that is "
                f"the infrastructure exposure Sentinel-City is actively triaging."
            ),
            "highlights": [
                f"Active disasters: {b['disasters_active']:,}",
                f"Cleared disasters: {b['disasters_cleared']:,}",
                f"Combined severity handled: {b['severity_sum']:,}",
                f"Estimated infrastructure value: ${s['infrastructure_value_usd']:,}",
            ],
        }
    if metric == "money":
        return {
            "title": f"${s['money_saved_usd'] / 1e6:.2f}M in operational savings from pre-positioning",
            "summary": (
                f"{b['dispatch_units']:,} unit(s) have been dispatched -- {b['auto_ambulances']:,} "
                f"ambulance(s) auto-routed to casualties plus operator/AI dispatches "
                f"({b['dispatches_completed']:,} run(s) already completed). At an estimated "
                f"${_OPS_SAVINGS_PER_UNIT_USD:,} saved per unit by routing from the nearest station "
                f"instead of reacting late, that is ${s['money_saved_usd']:,} in avoided operational cost."
            ),
            "highlights": [
                f"Units dispatched: {b['dispatch_units']:,}",
                f"Ambulances auto-routed to casualties: {b['auto_ambulances']:,}",
                f"Dispatch runs completed: {b['dispatches_completed']:,}",
                f"Total operational savings: ${s['money_saved_usd']:,}",
            ],
        }
    return None


@app.get("/api/savings-summary", tags=["Admin"])
def savings_summary():
    """Headline admin savings numbers, derived live from real event history."""
    return _compute_savings()


@app.get("/api/savings-summary/insight", tags=["Admin"])
def savings_insight(metric: Literal["lives", "infrastructure", "money"] = Query(...)):
    """Return a narrative for a savings tile, grounded in live event-history
    counts (resolved casualties, handled-disaster severity, dispatched units)."""
    insight = _savings_insight(metric)
    if insight is None:
        raise HTTPException(status_code=404, detail="Unknown metric.")
    return insight

@app.get("/api/logs", tags=["Logs"])
def get_audit_logs(limit: int = Query(100, ge=1, le=500)):
    # Source of truth is the in-process ring buffer in audit.py, so this
    # works regardless of where AuditLogger is writing files (or even if
    # the disk write failed). Newest-first.
    from audit import GLOBAL_LOG_BUFFER

    items = list(GLOBAL_LOG_BUFFER)[-limit:]
    items.reverse()
    return {"logs": items}


@app.delete("/api/logs", tags=["Logs"])
def clear_audit_logs():
    """Wipe the in-process audit ring buffer (what AILogsDrawer renders).

    Does NOT touch the daily JSONL files on disk — those remain the durable
    audit trail. This is purely a UI/demo convenience: after a wipe or
    between scenarios you can clear the drawer to start fresh.
    """
    from audit import GLOBAL_LOG_BUFFER
    n = len(GLOBAL_LOG_BUFFER)
    GLOBAL_LOG_BUFFER.clear()
    return {"cleared": n}


@app.get("/api/metrics", tags=["Logs"])
def get_metrics():
    """Live counters/gauges from the safety+efficiency layer.

    Surfaced in AILogsDrawer so a demo audience can see token-savings and
    verifier verdicts in real time. Cheap; safe to poll every few seconds.
    """
    from metrics import snapshot
    return snapshot()
