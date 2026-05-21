"""
Sentinel-City — FastAPI Backend (no-auth mode)
"""

import asyncio
import logging
import os
import uuid
import json
import math
import psycopg2
import psycopg2.extras
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Literal, Optional, Tuple
from dotenv import load_dotenv

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Boot the AI orchestrator's detection + monitoring loops alongside the API.

    Both loops talk to this same process via http://localhost:8000 (loopback,
    microseconds of overhead), keeping the orchestrator code's HTTP-based
    SentinelAPIClient unchanged. AuditLogger writes into the GLOBAL_LOG_BUFFER
    that /api/logs reads from, so AI logs work end-to-end in the deployed UI.
    """
    log = logging.getLogger("sentinel.lifespan")

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        log.warning("GOOGLE_CLOUD_PROJECT not set — skipping orchestrator startup.")
        yield
        return
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

    try:
        from google import genai
        from api_client import SentinelAPIClient
        from audit import AuditLogger
        from state import AgentState
        from orchestrator import detection_loop, monitoring_supervisor, load_prompt, set_tool_invoker
        from agent_tools import build_tools, make_tool_invoker
        from agent_graph import build_agent
    except Exception as exc:
        log.warning(f"Orchestrator import failed ({exc}); API will run without AI loops.")
        yield
        return

    # The orchestrator hits its own backend over loopback. Production env can
    # override via SENTINEL_API_URL (e.g. https://sentinel-backend-...run.app).
    base_url = os.environ.get("SENTINEL_API_URL", "http://localhost:8000")
    api = SentinelAPIClient(base_url=base_url)
    state = AgentState(agent_id="agent-sentinel-core")
    audit = AuditLogger()

    # The genai.Client below is ONLY used by tools.ToolExecutor._resolve_target_via_gemini
    # (a (0,0)-coordinate recovery helper). The main agent runs on Vertex AI.
    # We keep the AI Studio key path so the helper still works if you have one;
    # if not, target-resolution returns None and the LLM-provided target stands.
    gemini_api_key = os.environ.get("GEMINI_API_KEY")
    client = genai.Client(api_key=gemini_api_key) if gemini_api_key else None

    # Build the LangGraph ReAct agents on Vertex AI. The monitoring agent is
    # built with force_tool_use=True so Gemini cannot reply with "Would you
    # like me to proceed?" without actually invoking a tool.
    # Pre-register bus instances so wake-ups pushed before the loops start
    # awaiting (e.g. an early POST /api/citizen-report) get queued, not dropped.
    from wake_bus import WakeBus
    WakeBus.for_label("detection")
    WakeBus.for_label("monitoring")

    log.info(f"Building LangGraph agents (Vertex AI: project={project}, location={location})...")
    tools_list = build_tools(api, audit, client, agent_id=state.agent_id, state=state)
    set_tool_invoker(make_tool_invoker(tools_list))
    detection_prompt = await load_prompt("detection_prompt.md")
    monitoring_prompt = await load_prompt("monitoring_prompt.md")
    detection_agent = build_agent(project, location, detection_prompt, tools_list, force_tool_use=False)
    monitoring_agent = build_agent(project, location, monitoring_prompt, tools_list, force_tool_use=True)

    log.info(f"Starting orchestrator loops against {base_url}")
    detection_task = asyncio.create_task(detection_loop(api, state, audit, client, detection_agent))
    monitoring_task = asyncio.create_task(monitoring_supervisor(api, state, audit, client, monitoring_agent))

    # SLA watchdog: dispatch SLA + deadman heartbeat — forces a re-tick if
    # the system goes silent or declares without dispatching.
    from safety.sla import start_watchdog
    sla_task = start_watchdog(audit)

    # Wake-up watchers: turn polled APIs into bus events so the AI sleeps
    # until something interesting actually changes.
    from watchers import weather as _weather_watcher, traffic as _traffic_watcher
    weather_task = _weather_watcher.start(api)
    traffic_task = _traffic_watcher.start(api)

    background_tasks = (detection_task, monitoring_task, sla_task, weather_task, traffic_task)

    try:
        yield
    finally:
        log.info("Shutting down orchestrator loops")
        for t in background_tasks:
            t.cancel()
        for t in background_tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await api.close()


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
        conn.close()
        print("[schema] citizen_reports + responder_reports ready.")
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


class NotificationPayload(BaseModel):
    geometry: Dict[str, Any]
    reason: str
    event_id: Optional[str] = None


class CordonPayload(BaseModel):
    geometry: Dict[str, Any]
    reason: Optional[str] = None
    event_id: Optional[str] = None


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
                         people_inside, safe_exit_pct, parent_id, spread_in_seconds)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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

    Rows whose event_id isn't a syntactically valid UUID are also dropped
    silently — the engine emits synthetic ids like 'crime:<idx>:<t>' for
    operator-triggered robberies which aren't real disaster rows. Dropping them
    keeps the batch from failing on a Postgres UUID parse error.
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
    if not rows:
        return {"inserted": 0, "skipped": skipped}

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

    # Wake the AI: citizen call(s) just arrived. Push the centroid of the
    # batch (median of the lat/lng pairs) so the bus can area-dedupe.
    try:
        from wake_bus import WakeBus
        if batch.reports:
            lats = [float(r.location.get("lat", 0)) for r in batch.reports if isinstance(r.location, dict)]
            lngs = [float(r.location.get("lng", 0)) for r in batch.reports if isinstance(r.location, dict)]
            area = None
            if lats and lngs:
                area = {"lat": sum(lats) / len(lats), "lng": sum(lngs) / len(lngs)}
            await WakeBus.push_all(
                "citizen_report",
                area=area,
                payload={"count": len(batch.reports), "inserted": inserted},
            )
    except Exception:
        # Best-effort: never let the wake-up plumbing crash the ingest.
        pass

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

    # Wake the AI per distinct report_kind so the agent context's wake_reason
    # surfaces both casualties AND corrections when both arrive together.
    try:
        from wake_bus import WakeBus
        by_kind: Dict[str, List[ResponderReport]] = {}
        for r in batch.reports:
            by_kind.setdefault(r.report_kind, []).append(r)
        for kind, items in by_kind.items():
            lats = [float(r.location.get("lat", 0)) for r in items]
            lngs = [float(r.location.get("lng", 0)) for r in items]
            area = None
            if lats and lngs:
                area = {"lat": sum(lats) / len(lats), "lng": sum(lngs) / len(lngs)}
            await WakeBus.push_all(
                f"responder:{kind}",
                area=area,
                payload={"count": len(items)},
            )
    except Exception:
        pass

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
    return {"success": True, "deleted": deleted}


@app.delete("/api/disasters/{event_id}", tags=["Disasters"])
def delete_disaster(event_id: str):
    try:
        conn = psycopg2.connect(DATABASE_URL)
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM disaster_events WHERE id = %s;", (event_id,))
        conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Delete failed: {exc}",
        )
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
                           safe_exit_pct, created_at, location_estimate
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
                           safe_exit_pct, created_at, location_estimate
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
                    INSERT INTO notifications (id, geometry, reason, status, event_id)
                    VALUES (%s, %s, %s, 'active', %s)
                    RETURNING id;
                    """,
                    (notif_id, json.dumps(payload.geometry), payload.reason.strip(), payload.event_id),
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
                    SELECT id, geometry, reason, status, created_at, event_id
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
                    INSERT INTO cordons (id, geometry, reason, status, event_id)
                    VALUES (%s, %s, %s, 'active', %s)
                    RETURNING id;
                    """,
                    (cordon_id, json.dumps(payload.geometry), (payload.reason or "").strip() or None, payload.event_id),
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
                    SELECT id, geometry, reason, status, created_at, event_id
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
# into before they even pick up. Calls stay in memory — fine for hackathon
# scope; survives a single backend session.

EMERGENCY_CALLS: List[Dict[str, Any]] = []


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
    disaster_id: str = Field(..., description="UUID of the disaster the citizen is reporting.")
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


@app.post("/api/911/call", tags=["911"])
def create_emergency_call(payload: EmergencyCallPayload):
    """Citizens-only endpoint. Builds an enriched call record by joining the
    citizen + disaster details and pushes it onto the in-memory call log."""
    # Citizen resolution — we surface the friendly name in the call log.
    with _mobile_lock:
        citizen = MOBILE_CITIZENS.get(payload.citizen_id)
    if citizen is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Citizen not found — sign in again.",
        )

    # Disaster lookup — fail loud if the citizen claims they're inside a
    # disaster the operator already cleared. Front-end checks this too, but
    # we don't trust client state.
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
                        (payload.disaster_id,),
                    )
                    row = cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Disaster lookup failed: {exc}",
        )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Disaster no longer active.",
        )
    if row[4] != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Disaster status is '{row[4]}', not active.",
        )

    disaster_geom = _coerce_geojson(row[5])
    disaster_centroid = _geometry_centroid(disaster_geom)

    # De-dupe + canonicalise requested_services. The citizen UI sends
    # ['ambulance','police','firefighter'] for "all services"; we keep it as a
    # list rather than a flag so adding new service types later is non-breaking.
    services = sorted({s for s in payload.requested_services if s in EMERGENCY_SERVICES})
    if not services:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one valid requested service is required.",
        )

    call = {
        "id": str(uuid.uuid4()),
        "created_at": datetime.utcnow().isoformat() + "Z",
        # Citizen context
        "citizen_id": payload.citizen_id,
        "citizen_name": citizen.get("name") or "Unknown caller",
        "caller_lat": payload.caller_lat,
        "caller_lng": payload.caller_lng,
        # Disaster context — frozen at call time so the log reads correctly
        # even after the operator bumps severity or clears the event.
        "disaster_id": str(row[0]),
        "disaster_type": row[1],
        "severity": row[2],
        "cause": row[3],
        "disaster_lat": disaster_centroid["lat"] if disaster_centroid else None,
        "disaster_lng": disaster_centroid["lng"] if disaster_centroid else None,
        # Pre-built script the citizen "spoke" on tap.
        "transcript": payload.transcript.strip() or "(no transcript provided)",
        # Service routing — which responder types the citizen asked for.
        "requested_services": services,
        # Lifecycle: new → acknowledged → closed. Workers flip these.
        "status": "new",
        "acknowledged_by": None,
        "acknowledged_at": None,
        "closed_at": None,
        # Identity of the worker(s) who acknowledged. Multiple responders can
        # roll on a single call (e.g. ambulance + police on a major incident).
        "responders": [],  # list of {worker_id, sub_role, acknowledged_at}
    }
    EMERGENCY_CALLS.append(call)
    # Keep the log bounded so demo sessions don't grow unbounded in memory.
    if len(EMERGENCY_CALLS) > 500:
        del EMERGENCY_CALLS[:-500]
    return call


@app.get("/api/911/calls", tags=["911"])
def list_emergency_calls(
    status_filter: Optional[str] = Query(None, description="new|acknowledged|closed|all"),
    service: Optional[str] = Query(
        None,
        description="ambulance|police|firefighter — restrict to calls requesting this service. Workers should pass their own service to see their queue.",
    ),
):
    """Newest-first dispatch feed. Workers filter by `service` to see only
    calls relevant to their unit; admins / operators omit it for the full feed."""
    rows = list(EMERGENCY_CALLS)
    if status_filter and status_filter != "all":
        rows = [c for c in rows if c["status"] == status_filter]
    if service:
        if service not in EMERGENCY_SERVICES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"service must be one of {EMERGENCY_SERVICES}",
            )
        rows = [c for c in rows if service in c.get("requested_services", [])]
    rows.sort(key=lambda c: c["created_at"], reverse=True)
    return {"calls": rows}


class EmergencyCallUpdate(BaseModel):
    status: Optional[Literal["new", "acknowledged", "closed"]] = None
    # When a worker acknowledges, the client sends their userId + sub-role so
    # we can record who's rolling. Multiple workers can acknowledge the same
    # call (e.g. ambulance + police on a serious incident).
    worker_id: Optional[str] = None
    sub_role: Optional[Literal["paramedic", "police", "firefighter"]] = None


@app.patch("/api/911/calls/{call_id}", tags=["911"])
def update_emergency_call(call_id: str, update: EmergencyCallUpdate):
    """Mark a call acknowledged (responder en-route) or closed (incident
    resolved). Acknowledgements append to the responders list rather than
    overwriting — multiple services can take the same call."""
    for c in EMERGENCY_CALLS:
        if c["id"] != call_id:
            continue
        if update.status:
            c["status"] = update.status
            if update.status == "acknowledged" and not c.get("acknowledged_at"):
                c["acknowledged_at"] = datetime.utcnow().isoformat() + "Z"
            if update.status == "closed" and not c.get("closed_at"):
                c["closed_at"] = datetime.utcnow().isoformat() + "Z"
        if update.worker_id and update.sub_role:
            already = any(r.get("worker_id") == update.worker_id for r in c.get("responders", []))
            if not already:
                c.setdefault("responders", []).append({
                    "worker_id": update.worker_id,
                    "sub_role": update.sub_role,
                    "acknowledged_at": datetime.utcnow().isoformat() + "Z",
                })
            # Keep the legacy single-string field populated for backward compat.
            c["acknowledged_by"] = update.worker_id
        return c
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found.")


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


# Live-evolving savings counters. Numbers nudge up slightly on each read
# so the admin dashboard feels active during a demo. Production replaces
# this with values aggregated from the prediction / dispatch agents.
_SAVINGS_STATE: Dict[str, float] = {
    "lives_saved": 1284,
    "infrastructure_value_usd": 48_320_000,
    "money_saved_usd": 12_750_000,
    "last_tick": 0,
}


def _tick_savings() -> Dict[str, Any]:
    with _mobile_lock:
        _SAVINGS_STATE["lives_saved"] += 0.05
        _SAVINGS_STATE["infrastructure_value_usd"] += 1200
        _SAVINGS_STATE["money_saved_usd"] += 320
        _SAVINGS_STATE["last_tick"] += 1
        return {
            "lives_saved": int(_SAVINGS_STATE["lives_saved"]),
            "infrastructure_value_usd": int(_SAVINGS_STATE["infrastructure_value_usd"]),
            "money_saved_usd": int(_SAVINGS_STATE["money_saved_usd"]),
            "as_of": datetime.utcnow().isoformat() + "Z",
        }


@app.get("/api/savings-summary", tags=["Admin"])
def savings_summary():
    return _tick_savings()


# Pre-written "AI insight" narratives. The real prediction agent will
# replace these with generated text grounded in event history.
_SAVINGS_INSIGHTS: Dict[str, Dict[str, Any]] = {
    "lives": {
        "title": "How Sentinel-City saved 1,284 lives this quarter",
        "summary": (
            "The Spread Forecaster identified high-risk evacuation corridors "
            "an average of 14 minutes before flood crests, giving the Triage "
            "Agent enough lead time to escalate 1,843 citizen reports for "
            "early dispatch. Of those escalations, 1,284 ended in a citizen "
            "being routed to safety before a wave reached their location."
        ),
        "highlights": [
            "Median early-warning lead time: 14 min",
            "Citizens auto-rerouted around active hazards: 12,402",
            "Dispatches escalated by Triage Agent: 1,843",
            "Lives confirmed safe via app handshake: 1,284",
        ],
    },
    "infrastructure": {
        "title": "$48.3M in infrastructure preserved by predictive dispatch",
        "summary": (
            "Dispatch Optimizer pre-positioned fire trucks an average of "
            "4.2 minutes before ignition forecasts hit threshold, cutting "
            "structure-loss radius by ~38% on contained wildfires. "
            "Bridges and substations flagged by the Forecaster were "
            "barricaded by Routing Sentinel cordons before water arrived."
        ),
        "highlights": [
            "Structures protected from wildfire spread: 1,107",
            "Substations cordoned before storm impact: 14",
            "Avg. response time reduction: 3.8 min",
            "Estimated avoided rebuild cost: $48.3M",
        ],
    },
    "money": {
        "title": "$12.75M in operational savings",
        "summary": (
            "By rebalancing trucks to where the Spread Forecaster predicted "
            "they'd be needed, fleet utilization rose from 51% to 73%, "
            "removing the need for two contingency units. Citizen "
            "auto-rerouting also cut emergency overtime by 22%."
        ),
        "highlights": [
            "Fleet utilization: 51% → 73%",
            "Overtime spend reduced: 22%",
            "Mutual-aid callouts avoided: 47",
            "Total operational savings: $12.75M",
        ],
    },
}


@app.get("/api/savings-summary/insight", tags=["Admin"])
def savings_insight(metric: Literal["lives", "infrastructure", "money"] = Query(...)):
    """Return an AI-style narrative for a savings tile.
    Will be swapped to live-generated text once the prediction agent ships."""
    insight = _SAVINGS_INSIGHTS.get(metric)
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
