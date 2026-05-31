-- 011_operator_call_logs.sql
-- Audit log of AI-911-operator conversations. One row per call session, holding
-- the full caller↔operator chat plus the concise dispatch summary, so every call
-- is reviewable for compliance even if it was abandoned before dispatch.
-- (The backend also creates this idempotently on startup; this file documents
--  the schema and lets you apply it directly to a fresh DB.)

CREATE TABLE IF NOT EXISTS operator_call_logs (
    -- The live in-memory session id (one per call). Primary key so the backend
    -- can upsert the row every turn as the conversation grows.
    session_id    TEXT PRIMARY KEY,
    -- The emergency_calls.id this call dispatched (NULL until / unless dispatched).
    call_id       UUID,
    citizen_id    TEXT,
    citizen_name  TEXT,
    started_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    caller_lat    DOUBLE PRECISION,
    caller_lng    DOUBLE PRECISION,
    location_name TEXT,
    -- Full transcript: [{ "role": "caller"|"operator", "text": "...", "ts": "..." }, ...]
    conversation  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Concise responder-facing brief generated at end-of-call.
    summary       TEXT,
    -- Final dispatch decision: ["ambulance","police","firefighter"].
    services      JSONB,
    severity      INTEGER,
    category      TEXT,
    ended         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_operator_logs_updated
    ON operator_call_logs (updated_at DESC);
