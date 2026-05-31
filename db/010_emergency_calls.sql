-- 010_emergency_calls.sql
-- Persist 911 calls so the live call log and the per-service accept/resolve
-- lanes survive backend restarts and can be served by more than one instance.
-- (The backend also creates this idempotently on startup; this file documents
--  the schema and lets you apply it directly to a fresh DB.)

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
    -- Per-service lifecycle: { "ambulance": "new", "police": "acknowledged", ... }
    service_status     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Derived summary lifecycle: new | acknowledged | closed.
    status             TEXT NOT NULL DEFAULT 'new',
    acknowledged_by    TEXT,
    acknowledged_at    TIMESTAMPTZ,
    closed_at          TIMESTAMPTZ,
    responders         JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Proof photo (base64 data URL). Kept in its own column and never selected
    -- into the list feed — fetched on demand via /api/911/calls/{id}/photo.
    photo_data_url     TEXT,
    ai_assessment      JSONB,
    -- Client-supplied per-attempt key → at-most-once call placement on retry.
    idempotency_key    TEXT,
    -- Caller's saved profile (vitals/medical/contact). Shown to the operator /
    -- responders ("Caller details"); never spoken in the transcript.
    caller_profile     JSONB
);

-- For DBs created before caller_profile existed.
ALTER TABLE emergency_calls ADD COLUMN IF NOT EXISTS caller_profile JSONB;

-- Concise AI-operator dispatch brief shown to responders. The full caller↔operator
-- conversation lives in operator_call_logs (see 011_operator_call_logs.sql).
ALTER TABLE emergency_calls ADD COLUMN IF NOT EXISTS summary TEXT;

CREATE INDEX IF NOT EXISTS idx_emergency_calls_created
    ON emergency_calls (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emergency_calls_idem
    ON emergency_calls (idempotency_key) WHERE idempotency_key IS NOT NULL;
