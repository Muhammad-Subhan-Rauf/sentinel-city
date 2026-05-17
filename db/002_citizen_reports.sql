-- Adds citizen_reports for existing volumes where init.sql has already run.
-- Safe to run multiple times.

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

-- Backward-compat: drop the FK if a prior version of the schema added it.
ALTER TABLE citizen_reports DROP CONSTRAINT IF EXISTS citizen_reports_event_id_fkey;

CREATE INDEX IF NOT EXISTS idx_citizen_reports_event
    ON citizen_reports (event_id);

CREATE INDEX IF NOT EXISTS idx_citizen_reports_recent
    ON citizen_reports (reported_at DESC);
