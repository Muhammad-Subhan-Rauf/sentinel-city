-- 012_mobile_users.sql
-- Persist the mobile-app roster (citizens / emergency workers / admins) plus
-- each user's last known location & status, so a backend restart picks up the
-- same users instead of forgetting everyone (the roster used to live only in
-- memory). The backend keeps an in-memory copy for fast reads, writes through
-- to this table on every login / location / status change, and hydrates from it
-- on startup. (The backend also creates this idempotently on startup; this file
--  documents the schema and lets you apply it directly to a fresh DB.)

CREATE TABLE IF NOT EXISTS mobile_users (
    -- device_id for citizens/admins, or "device_id:sub_role" for workers (so one
    -- phone signed in as firefighter then police keeps two distinct records).
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    role        TEXT NOT NULL,            -- 'citizen' | 'worker' | 'admin'
    sub_role    TEXT,                     -- firefighter | paramedic | police (workers only)
    name        TEXT,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    status      TEXT,                     -- citizen: safe|warned|evacuating|affected; worker: available|dispatched|on_scene|off_duty
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
