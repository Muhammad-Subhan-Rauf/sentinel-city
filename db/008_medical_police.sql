-- Medical + police framework — mirrors the fire_stations pattern.
--   * hospitals       — operator-placed map objects. Ambulances spawn from
--                       and return to these; patients are healed on arrival.
--   * police_stations — operator-placed map objects. Officers patrol around
--                       and/or in operator-marked circles. Roughly half of
--                       each station's roster auto-patrols at all times.
-- All statements are idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS hospitals (
    id                    UUID PRIMARY KEY,
    name                  TEXT,
    lat                   DOUBLE PRECISION NOT NULL,
    lng                   DOUBLE PRECISION NOT NULL,
    ambulance_count       INTEGER NOT NULL DEFAULT 3,
    ambulances_dispatched INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS police_stations (
    id                UUID PRIMARY KEY,
    name              TEXT,
    lat               DOUBLE PRECISION NOT NULL,
    lng               DOUBLE PRECISION NOT NULL,
    police_count      INTEGER NOT NULL DEFAULT 10,
    police_dispatched INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
