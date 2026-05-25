"""Single source of truth for PostGIS coordinate construction.

Trap 3b: PostGIS happily accepts ``ST_MakePoint(lat, lng)`` (wrong order)
and produces points in the wrong hemisphere. ST_DWithin won't error — it
just silently returns empty clusters forever, the kind of bug that ships
to production and burns a week to find.

Every coordinate going into the database goes through ``to_geom_sql`` or
``to_geom_params``. The CI test in ``tests/test_pipeline_geo.py`` inserts
a known Dubai coordinate and asserts ST_DWithin finds it within 50 m — if
that ever fails, this module is wrong.
"""

from __future__ import annotations

from typing import Tuple


def assert_wgs84(lat: float, lng: float) -> None:
    """Reject obviously-wrong values before they reach PostgreSQL.

    A swapped lat/lng often shows up as |lng| > 90 (because longitudes can
    reach 180 but latitudes can't). We can't catch every case — a Dubai
    coordinate is valid as either lat or lng numerically — but we can
    catch the gross mistakes.
    """
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        raise TypeError(f"lat/lng must be numeric, got {type(lat).__name__}/{type(lng).__name__}")
    if not (-90.0 <= float(lat) <= 90.0):
        raise ValueError(f"lat={lat} outside WGS84 range (-90, 90)")
    if not (-180.0 <= float(lng) <= 180.0):
        raise ValueError(f"lng={lng} outside WGS84 range (-180, 180)")


def to_geom_sql() -> str:
    """SQL fragment for inserting a (lat, lng) pair into a geography column.

    Use as: ``cur.execute("INSERT ... VALUES (..., " + to_geom_sql() + ")", (..., lng, lat))``

    Note the parameter order: **lng FIRST, lat SECOND** to match
    ST_MakePoint's (X, Y) = (lng, lat) signature. Always call
    ``to_geom_params(lat, lng)`` to get the tuple in the right order.
    """
    return "ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography"


def to_geom_params(lat: float, lng: float) -> Tuple[float, float]:
    """Return the (lng, lat) tuple to bind to ``to_geom_sql()``'s placeholders.

    Validates the values first. Order matters: ST_MakePoint takes (X, Y)
    where X is longitude. This is the helper you call EVERY TIME you put
    coordinates in the DB so the order can never get flipped at a call site.
    """
    assert_wgs84(lat, lng)
    return (float(lng), float(lat))
