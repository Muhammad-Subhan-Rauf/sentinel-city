-- Emergency services framework:
--   * fire_stations  — persistent map objects placed by the operator via the
--                      hidden settings panel. Trucks spawn from / return to
--                      these.
--   * notifications  — operator-triggered evacuation alerts (polygon + reason).
--                      Persisted so AI consumers can list active alerts.
--   * spread_in_seconds — per-Building_Fire delayed spread timer. NULL means
--                      "no delayed spread configured" (legacy / non-fire rows).
-- All statements are idempotent — safe to run multiple times against any DB
-- (docker-compose volume or Supabase).

CREATE TABLE IF NOT EXISTS fire_stations (
    id         UUID PRIMARY KEY,
    name       TEXT,
    lat        DOUBLE PRECISION NOT NULL,
    lng        DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
    id         UUID PRIMARY KEY,
    geometry   JSONB NOT NULL,
    reason     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_active
    ON notifications (status)
    WHERE status = 'active';

-- Cordons — operator-marked "no entry" zones. Citizens (not emergency units)
-- refuse to walk into a cordoned area. They wait at the boundary until the
-- cordon is cleared. Reason is shown in the UI.
CREATE TABLE IF NOT EXISTS cordons (
    id         UUID PRIMARY KEY,
    geometry   JSONB NOT NULL,
    reason     TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cordons_active
    ON cordons (status)
    WHERE status = 'active';

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS spread_in_seconds INTEGER;
