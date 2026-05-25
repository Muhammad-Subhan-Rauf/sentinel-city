"""Geom-helper unit tests + PostGIS SRID smoke test (Trap 3b).

The unit tests run anywhere — they only exercise the input validation.

The SRID smoke test inserts a known Dubai coordinate into a transient
table and asserts ST_DWithin finds it within 50 m of itself. It is
skipped unless the SENTINEL_PG_INTEGRATION env var points at a real
Postgres+PostGIS. CI should set it; local dev can opt in.

If the smoke test ever fails, the (lng, lat) order is wrong somewhere.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline._geom import assert_wgs84, to_geom_params, to_geom_sql


# ── Unit tests (no DB required) ─────────────────────────────────────────


def test_assert_wgs84_accepts_dubai():
    # Dubai: lat=25.2048, lng=55.2708
    assert_wgs84(25.2048, 55.2708)


def test_assert_wgs84_accepts_extremes():
    assert_wgs84(-90.0, -180.0)
    assert_wgs84(90.0, 180.0)
    assert_wgs84(0.0, 0.0)


def test_assert_wgs84_rejects_out_of_range_lat():
    with pytest.raises(ValueError):
        assert_wgs84(95.0, 0.0)
    with pytest.raises(ValueError):
        assert_wgs84(-95.0, 0.0)


def test_assert_wgs84_rejects_out_of_range_lng():
    with pytest.raises(ValueError):
        assert_wgs84(0.0, 200.0)
    with pytest.raises(ValueError):
        assert_wgs84(0.0, -200.0)


def test_assert_wgs84_rejects_non_numeric():
    with pytest.raises(TypeError):
        assert_wgs84("25", "55")  # type: ignore[arg-type]


def test_to_geom_params_returns_lng_first():
    """The single most important invariant in this module."""
    lng_first, lat_second = to_geom_params(lat=25.2048, lng=55.2708)
    assert lng_first == 55.2708
    assert lat_second == 25.2048


def test_to_geom_sql_uses_st_makepoint_with_4326():
    sql = to_geom_sql()
    assert "ST_MakePoint" in sql
    assert "4326" in sql
    assert "geography" in sql


# ── SRID smoke test (integration; opt-in via SENTINEL_PG_INTEGRATION) ───


_PG_URL = os.environ.get("SENTINEL_PG_INTEGRATION")
_pytestmark_integration = pytest.mark.skipif(
    _PG_URL is None,
    reason="SENTINEL_PG_INTEGRATION not set; integration test skipped",
)


@_pytestmark_integration
def test_srid_smoke_dubai_self_lookup():
    """Insert Dubai. ST_DWithin should find it within 50 m of itself.

    If this fails, somewhere a lat/lng pair got flipped or the SRID is wrong.
    Run with: SENTINEL_PG_INTEGRATION=postgresql://... pytest tests/test_pipeline_geo.py
    """
    import psycopg2

    conn = psycopg2.connect(_PG_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                # Use a TEMP table so we don't pollute the real schema.
                cur.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
                cur.execute(
                    "CREATE TEMP TABLE _srid_smoke (id SERIAL PRIMARY KEY, geom geography(Point, 4326));"
                )

                # The helper under test:
                lng, lat = to_geom_params(lat=25.2048, lng=55.2708)
                cur.execute(
                    f"INSERT INTO _srid_smoke (geom) VALUES ({to_geom_sql()}) RETURNING id;",
                    (lng, lat),
                )
                inserted_id = cur.fetchone()[0]

                # Query for everything within 50m of Dubai (same coords).
                cur.execute(
                    """
                    SELECT id FROM _srid_smoke
                    WHERE ST_DWithin(
                        geom,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                        50
                    );
                    """,
                    (55.2708, 25.2048),  # lng, lat
                )
                rows = cur.fetchall()

        assert len(rows) == 1, (
            "ST_DWithin failed to find Dubai within 50 m of itself — the "
            "(lng, lat) order is wrong somewhere in pipeline._geom or the "
            "migration. See plan Trap 3b."
        )
        assert rows[0][0] == inserted_id
    finally:
        conn.close()


@_pytestmark_integration
def test_srid_swapped_coordinates_would_not_match():
    """Sanity: if we (wrongly) used ST_MakePoint(lat, lng), the row would NOT
    be found in Dubai. This guards against an accidental refactor that
    silently flips the order."""
    import psycopg2

    conn = psycopg2.connect(_PG_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
                cur.execute(
                    "CREATE TEMP TABLE _srid_swap (id SERIAL PRIMARY KEY, geom geography(Point, 4326));"
                )
                # Insert with the WRONG order on purpose:
                cur.execute(
                    "INSERT INTO _srid_swap (geom) VALUES "
                    "(ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography);",
                    (25.2048, 55.2708),  # lat as X, lng as Y — wrong
                )
                # Looking up the real Dubai location should find nothing.
                cur.execute(
                    """
                    SELECT id FROM _srid_swap
                    WHERE ST_DWithin(
                        geom,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                        50
                    );
                    """,
                    (55.2708, 25.2048),  # correct Dubai lng, lat
                )
                rows = cur.fetchall()
        assert len(rows) == 0, (
            "Swapped-coordinate row matched Dubai location — the smoke "
            "test is itself broken."
        )
    finally:
        conn.close()
