-- Adds geometry_kind to existing disaster_events. Also relaxes area_geometry
-- to allow NULL (city-wide events have no geometry).
-- Safe to run multiple times.

ALTER TABLE disaster_events
    ALTER COLUMN area_geometry DROP NOT NULL;

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS geometry_kind TEXT
    CHECK (geometry_kind IN ('point', 'area', 'city'));
