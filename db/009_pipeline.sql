-- 009_pipeline.sql
-- Schema for the single-pass NLU pipeline that replaces the LangGraph
-- ReAct loops. See plan: the-current-ai-feels-cosmic-candle.md.
--
-- Idempotent. Safe to re-run.

-- ────────────────────────────────────────────────────────────────────
-- 1. PostGIS extension (Supabase usually has this on; idempotent).
-- ────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;

-- ────────────────────────────────────────────────────────────────────
-- 2. citizen_reports.geom — geography(Point, 4326), backfilled from the
--    existing JSONB `location` column.
--
--    Trap 3b: lng comes FIRST in ST_MakePoint. ST_DWithin will silently
--    return empty clusters forever if this gets flipped, so the
--    application uses a single helper (backend/pipeline/_geom.to_geom)
--    and CI runs the SRID smoke test in tests/test_pipeline_geo.py.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE citizen_reports
    ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);

-- Backfill any pre-existing rows. Rows whose location JSON lacks valid
-- lat/lng are left NULL (the pipeline refuses to plan dispatch for
-- coord-less reports and audit-logs them for operator triage).
UPDATE citizen_reports
SET geom = ST_SetSRID(
    ST_MakePoint(
        (location->>'lng')::double precision,
        (location->>'lat')::double precision
    ),
    4326
)::geography
WHERE geom IS NULL
  AND location ? 'lat'
  AND location ? 'lng'
  AND (location->>'lat') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND (location->>'lng') ~ '^-?[0-9]+(\.[0-9]+)?$';

-- GIST index makes ST_DWithin queries sub-linear over the table.
CREATE INDEX IF NOT EXISTS idx_citizen_reports_geom
    ON citizen_reports USING GIST (geom);

-- A separate B-tree on the time column accelerates the temporal
-- predicate that clustering ANDs onto the spatial join.
CREATE INDEX IF NOT EXISTS idx_citizen_reports_reported_at
    ON citizen_reports (reported_at);

-- Pipeline-stamp column: which declared_incident absorbed this report.
-- NULL = still unclustered / not yet attributed.
ALTER TABLE citizen_reports
    ADD COLUMN IF NOT EXISTS declared_incident_id UUID;

CREATE INDEX IF NOT EXISTS idx_citizen_reports_undeclared
    ON citizen_reports (reported_at)
    WHERE declared_incident_id IS NULL;

-- The NLU extraction output gets persisted on the row so the dashboard
-- can show what the model thought without re-querying the model. Also
-- powers the calibration step in plan §Verification step 8.
ALTER TABLE citizen_reports
    ADD COLUMN IF NOT EXISTS nlu_extraction JSONB;


-- ────────────────────────────────────────────────────────────────────
-- 3. nlu_cache — memoize identical transcripts so duplicate / replayed
--    citizen reports skip the LLM entirely. Plan §Mandate 5.
--
--    Key: sha256 of the normalized transcript (whitespace-collapsed,
--    lowercased) per pipeline.extract.transcript_hash().
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nlu_cache (
    transcript_hash TEXT PRIMARY KEY,
    model_version   TEXT NOT NULL,
    extraction      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nlu_cache_created
    ON nlu_cache (created_at);


-- ────────────────────────────────────────────────────────────────────
-- 4. Row-level locking prerequisites
--
--    Mandate 2/§Concurrency: SELECT ... FOR UPDATE on stations + incidents
--    serializes concurrent workers so 3 simultaneous identical reports
--    can't all decide to dispatch independently.
--
--    No new columns required — the existing `stations` and
--    `disaster_events` (incidents) rows are lockable as-is. We just need
--    to make sure the join keys are indexed (most already are).
-- ────────────────────────────────────────────────────────────────────
-- No-op block: SELECT FOR UPDATE works on any PK row. Indexes already
-- exist for the foreign-key columns the pipeline locks.


-- ────────────────────────────────────────────────────────────────────
-- 5. SRID smoke test seed (Trap 3b)
--
--    A canonical Dubai-coordinate row the CI test inserts and reads
--    back through ST_DWithin to prove the lng/lat order is correct.
--    Not inserted here — the test inserts and rolls back. This block
--    exists as documentation.
-- ────────────────────────────────────────────────────────────────────
-- Dubai (lat=25.2048, lng=55.2708) — see tests/test_pipeline_geo.py
