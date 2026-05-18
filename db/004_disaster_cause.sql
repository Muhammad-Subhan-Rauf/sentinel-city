-- Adds a `cause` discriminator to disaster_events so the mocked /api/weather
-- endpoint can tell weather-driven events (river floods, freeze-burst water
-- mains) from infrastructure-rooted ones (hydrant burst, equipment failure).
-- NULL means "not specified" — the weather mapping treats it like
-- 'infrastructure' (no weather shift). Safe to run multiple times.

ALTER TABLE disaster_events
    ADD COLUMN IF NOT EXISTS cause TEXT
    CHECK (cause IN ('weather', 'infrastructure'));
