-- Schema bootstrap for Sentinel-City.
-- Postgres runs every .sql file in /docker-entrypoint-initdb.d/ exactly
-- once on the first container launch (when the data volume is empty).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS disaster_events (
    id            UUID PRIMARY KEY,
    disaster_type TEXT NOT NULL,
    severity      INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 10),
    area_geometry JSONB,
    geometry_kind TEXT CHECK (geometry_kind IN ('point', 'area', 'city')),
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disaster_events_created_at
    ON disaster_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_disaster_events_active
    ON disaster_events (status)
    WHERE status = 'active';

-- No FK to disaster_events: citizen reports reference in-frontend zone IDs
-- that only get persisted to disaster_events when the operator clicks
-- Trigger. The FK would otherwise block every report write.
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
