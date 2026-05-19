"""
Idempotent migration script for the Sentinel-City schema.

Brings any target Postgres (Supabase, local, docker) up to the canonical schema
defined in db/init.sql plus all subsequent ALTERs. Safe to re-run.

Reads DATABASE_URL from backend/.env (or the process environment). Run from
the repo root:

    python backend/scripts/migrate.py

Or from inside backend/:

    python scripts/migrate.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print(f"DATABASE_URL not set (looked in {ENV_PATH}).", file=sys.stderr)
    sys.exit(1)


# Ordered, idempotent steps. Each tuple is (label shown in output, SQL).
STEPS: list[tuple[str, str]] = [
    (
        "Ensure uuid-ossp extension",
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
    ),
    (
        "Create disaster_events table (no-op if present)",
        """
        CREATE TABLE IF NOT EXISTS disaster_events (
            id            UUID PRIMARY KEY,
            disaster_type TEXT NOT NULL,
            severity      INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 10),
            area_geometry JSONB,
            geometry_kind TEXT,
            notes         TEXT,
            status        TEXT NOT NULL DEFAULT 'active',
            cause         TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
    (
        "Relax disaster_events.area_geometry NOT NULL",
        "ALTER TABLE disaster_events ALTER COLUMN area_geometry DROP NOT NULL;",
    ),
    (
        "Add disaster_events.geometry_kind",
        """
        ALTER TABLE disaster_events
        ADD COLUMN IF NOT EXISTS geometry_kind TEXT
        CHECK (geometry_kind IN ('point', 'area', 'city'));
        """,
    ),
    (
        "Add disaster_events.notes",
        "ALTER TABLE disaster_events ADD COLUMN IF NOT EXISTS notes TEXT;",
    ),
    (
        "Add disaster_events.status",
        "ALTER TABLE disaster_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';",
    ),
    (
        "Add disaster_events.cause",
        """
        ALTER TABLE disaster_events
        ADD COLUMN IF NOT EXISTS cause TEXT
        CHECK (cause IN ('weather', 'infrastructure'));
        """,
    ),
    (
        "Add disaster_events.spread_speed",
        """
        ALTER TABLE disaster_events
        ADD COLUMN IF NOT EXISTS spread_speed REAL NOT NULL DEFAULT 1.0;
        """,
    ),
    (
        "Add disaster_events.people_inside",
        "ALTER TABLE disaster_events ADD COLUMN IF NOT EXISTS people_inside INTEGER;",
    ),
    (
        "Add disaster_events.safe_exit_pct",
        """
        ALTER TABLE disaster_events
        ADD COLUMN IF NOT EXISTS safe_exit_pct REAL CHECK (safe_exit_pct BETWEEN 0 AND 100);
        """,
    ),
    (
        "Add disaster_events.parent_id",
        "ALTER TABLE disaster_events ADD COLUMN IF NOT EXISTS parent_id UUID;",
    ),
    (
        "Add disaster_events.spread_in_seconds",
        "ALTER TABLE disaster_events ADD COLUMN IF NOT EXISTS spread_in_seconds INTEGER;",
    ),
    (
        "Create fire_stations table",
        """
        CREATE TABLE IF NOT EXISTS fire_stations (
            id         UUID PRIMARY KEY,
            name       TEXT,
            lat        DOUBLE PRECISION NOT NULL,
            lng        DOUBLE PRECISION NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
    (
        "Create notifications table",
        """
        CREATE TABLE IF NOT EXISTS notifications (
            id         UUID PRIMARY KEY,
            geometry   JSONB NOT NULL,
            reason     TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
    (
        "Index notifications.status='active'",
        """
        CREATE INDEX IF NOT EXISTS idx_notifications_active
            ON notifications (status)
            WHERE status = 'active';
        """,
    ),
    (
        "Create cordons table",
        """
        CREATE TABLE IF NOT EXISTS cordons (
            id         UUID PRIMARY KEY,
            geometry   JSONB NOT NULL,
            reason     TEXT,
            status     TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
    (
        "Index cordons.status='active'",
        """
        CREATE INDEX IF NOT EXISTS idx_cordons_active
            ON cordons (status)
            WHERE status = 'active';
        """,
    ),
    (
        "Index disaster_events.created_at",
        """
        CREATE INDEX IF NOT EXISTS idx_disaster_events_created_at
        ON disaster_events (created_at DESC);
        """,
    ),
    (
        "Partial index on disaster_events.status='active'",
        """
        CREATE INDEX IF NOT EXISTS idx_disaster_events_active
        ON disaster_events (status)
        WHERE status = 'active';
        """,
    ),
    (
        "Create citizen_reports table",
        """
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
        """,
    ),
    (
        "Drop legacy FK on citizen_reports.event_id",
        """
        ALTER TABLE citizen_reports
        DROP CONSTRAINT IF EXISTS citizen_reports_event_id_fkey;
        """,
    ),
    (
        "Index citizen_reports.event_id",
        "CREATE INDEX IF NOT EXISTS idx_citizen_reports_event ON citizen_reports (event_id);",
    ),
    (
        "Index citizen_reports.reported_at",
        "CREATE INDEX IF NOT EXISTS idx_citizen_reports_recent ON citizen_reports (reported_at DESC);",
    ),
    (
        "Add fire_stations.truck_count",
        "ALTER TABLE fire_stations ADD COLUMN IF NOT EXISTS truck_count INTEGER NOT NULL DEFAULT 4;",
    ),
    (
        "Add fire_stations.trucks_dispatched",
        "ALTER TABLE fire_stations ADD COLUMN IF NOT EXISTS trucks_dispatched INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        "Create hospitals table",
        """
        CREATE TABLE IF NOT EXISTS hospitals (
            id                    UUID PRIMARY KEY,
            name                  TEXT,
            lat                   DOUBLE PRECISION NOT NULL,
            lng                   DOUBLE PRECISION NOT NULL,
            ambulance_count       INTEGER NOT NULL DEFAULT 3,
            ambulances_dispatched INTEGER NOT NULL DEFAULT 0,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
    (
        "Create police_stations table",
        """
        CREATE TABLE IF NOT EXISTS police_stations (
            id                UUID PRIMARY KEY,
            name              TEXT,
            lat               DOUBLE PRECISION NOT NULL,
            lng               DOUBLE PRECISION NOT NULL,
            police_count      INTEGER NOT NULL DEFAULT 10,
            police_dispatched INTEGER NOT NULL DEFAULT 0,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """,
    ),
]


def main() -> None:
    target = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Target: {target}\n")
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                for label, sql in STEPS:
                    print(f"  · {label} …", end=" ", flush=True)
                    try:
                        cur.execute(sql)
                        print("ok")
                    except Exception as exc:
                        print(f"FAILED\n      {exc}")
                        raise
    finally:
        conn.close()
    print("\nMigration complete.")


if __name__ == "__main__":
    main()
