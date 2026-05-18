-- Adds per-zone spread_speed multiplier on disaster_events. 1.0 means "use the
-- per-type default rate from disasterProfiles.spreadRateMps(severity)"; values
-- below/above scale the wave expansion proportionally. Safe to run multiple
-- times.

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS spread_speed REAL NOT NULL DEFAULT 1.0;
