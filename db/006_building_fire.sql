-- Adds Building_Fire-specific fields:
--   people_inside     — total occupants of the burning building at trigger.
--   safe_exit_pct     — percentage (0-100) who successfully evacuate; the
--                       remainder are casualties trapped inside.
--   parent_id         — for fires that spread from a primary blaze. NULL for
--                       independent ignitions; otherwise references the
--                       upstream disaster_events row.
-- All three are nullable so non-fire disasters can keep ignoring them.
-- Safe to run multiple times.

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS people_inside INTEGER;

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS safe_exit_pct REAL CHECK (safe_exit_pct BETWEEN 0 AND 100);

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS parent_id UUID;
