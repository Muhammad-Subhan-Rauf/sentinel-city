-- Schema bootstrap for Sentinel-City.
-- Postgres runs every .sql file in /docker-entrypoint-initdb.d/ exactly
-- once on the first container launch (when the data volume is empty).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS disaster_events (
    id            UUID PRIMARY KEY,
    disaster_type TEXT NOT NULL,
    severity      INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 10),
    area_geometry JSONB NOT NULL,
    notes         TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disaster_events_created_at
    ON disaster_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_disaster_events_active
    ON disaster_events (status)
    WHERE status = 'active';
