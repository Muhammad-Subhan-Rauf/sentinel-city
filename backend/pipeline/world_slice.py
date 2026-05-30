"""Geo-bounded reads for the decision engine.

Replaces the wholesale ``get_disasters / get_weather / get_traffic /
get_citizen_reports / get_responder_reports`` payload the old monitoring
agent shoveled into every prompt (8–12 KB). Per Mandate 4: the decision
engine only sees data within the radius of the specific incident it's
planning a response for.

Important: the LLM is no longer the consumer here. Python's
``pipeline.decide.plan_response`` reads the WorldSlice. So "context bloat"
stops being a token concern and starts being a DB-query concern. The
queries use PostGIS so they're sub-linear; the slice is dataclasses, not
free-form JSON.

Station distance uses PostGIS ``ST_DistanceSphere`` against the existing
``fire_stations`` table (which stores ``lat``, ``lng`` as DOUBLE PRECISION,
no geom column yet — we synthesise one in-query). If you later migrate
stations to a geography column, swap to ``ST_Distance``.

Note: ``ST_MakePoint`` and ``ST_DistanceSphere`` both take ``(lng, lat)``.
The helper from ``pipeline._geom`` is the only place that order lives.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, List, Optional

from pipeline._geom import to_geom_params

logger = logging.getLogger(__name__)


# ── Data shapes ─────────────────────────────────────────────────────────


@dataclass
class IncidentRef:
    """Compact incident handle. The full row stays in the DB."""
    id: str
    disaster_type: str
    severity: int          # 1..10 per disaster_events.severity
    lat: float
    lng: float
    status: str
    notes: Optional[str] = None


@dataclass
class StationRef:
    id: str
    name: str
    lat: float
    lng: float
    dist_m: float          # haversine from the incident centroid
    truck_count: int = 0   # total trucks the station owns
    trucks_dispatched: int = 0  # trucks currently out on other dispatches

    @property
    def available(self) -> int:
        return max(0, self.truck_count - self.trucks_dispatched)


@dataclass
class CordonRef:
    id: str
    reason: Optional[str]
    status: str
    # The cordon table stores geometry as JSONB GeoJSON. We don't try to
    # decode it here — decide.py only needs to know cordons exist nearby.
    raw_geometry: Any


@dataclass
class ReportRef:
    id: str
    reported_at: Any
    transcript: str
    lat: float
    lng: float
    incident_type: Optional[str]   # from nlu_extraction
    severity: Optional[str]
    casualties_mentioned: bool


@dataclass
class WorldSlice:
    """Everything decide.py needs to plan a response for one incident."""
    incident: IncidentRef
    nearby_stations: List[StationRef] = field(default_factory=list)
    nearby_cordons: List[CordonRef] = field(default_factory=list)
    nearby_reports: List[ReportRef] = field(default_factory=list)


# ── SQL ─────────────────────────────────────────────────────────────────


_INCIDENT_SQL = """
SELECT
    id,
    disaster_type,
    severity,
    status,
    notes,
    COALESCE(
        (location_estimate->>'lat')::double precision,
        ST_Y(ST_Centroid(
            CASE
                WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                  THEN ST_GeomFromGeoJSON(area_geometry::text)
                ELSE area_geometry
            END
        )::geometry)
    ) AS lat,
    COALESCE(
        (location_estimate->>'lng')::double precision,
        ST_X(ST_Centroid(
            CASE
                WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                  THEN ST_GeomFromGeoJSON(area_geometry::text)
                ELSE area_geometry
            END
        )::geometry)
    ) AS lng
FROM disaster_events
WHERE id = %s;
"""


# Note: lng comes first in ST_MakePoint. ST_DistanceSphere measures in meters.
# truck_count + trucks_dispatched are surfaced so the AI dispatch agent can
# see real per-station capacity (no more "max 2 per station" hardcoded cap).
_STATIONS_SQL = """
SELECT
    id, name, lat, lng,
    ST_DistanceSphere(
        ST_SetSRID(ST_MakePoint(lng, lat), 4326),
        ST_SetSRID(ST_MakePoint(%s, %s), 4326)
    ) AS dist_m,
    COALESCE(truck_count, 0)        AS truck_count,
    COALESCE(trucks_dispatched, 0)  AS trucks_dispatched
FROM fire_stations
ORDER BY dist_m ASC
LIMIT %s;
"""


_CORDONS_SQL = """
SELECT id, reason, status, geometry
FROM cordons
WHERE status = 'active';
"""


_NEARBY_REPORTS_SQL = """
SELECT
    id,
    reported_at,
    transcript,
    ST_Y(geom::geometry) AS lat,
    ST_X(geom::geometry) AS lng,
    nlu_extraction->>'incident_type' AS incident_type,
    nlu_extraction->>'severity' AS severity,
    COALESCE((nlu_extraction->>'casualties_mentioned')::boolean, FALSE) AS casualties_mentioned
FROM citizen_reports
WHERE geom IS NOT NULL
  AND ST_DWithin(
      geom,
      ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
      %s
  )
ORDER BY reported_at DESC
LIMIT %s;
"""


# ── Builder ─────────────────────────────────────────────────────────────


def slice_for_incident(
    conn: Any,
    incident_id: str,
    *,
    radius_m: float = 2000.0,
    k_stations: int = 3,
    max_reports: int = 25,
) -> Optional[WorldSlice]:
    """Build a WorldSlice for the given incident.

    Returns None if the incident doesn't exist or has no resolvable
    coordinates. The caller should treat that as "skip — operator will
    triangulate" rather than crash.
    """
    incident = _fetch_incident(conn, incident_id)
    if incident is None:
        return None

    lng_lat = to_geom_params(incident.lat, incident.lng)

    stations = _fetch_stations(conn, lng_lat, k=k_stations)
    cordons = _fetch_cordons(conn)
    reports = _fetch_nearby_reports(conn, lng_lat, radius_m=radius_m, max_reports=max_reports)

    return WorldSlice(
        incident=incident,
        nearby_stations=stations,
        nearby_cordons=cordons,
        nearby_reports=reports,
    )


def _fetch_incident(conn: Any, incident_id: str) -> Optional[IncidentRef]:
    with conn.cursor() as cur:
        cur.execute(_INCIDENT_SQL, (incident_id,))
        row = cur.fetchone()
    if row is None:
        return None
    _id, dtype, severity, status, notes, lat, lng = row
    if lat is None or lng is None:
        logger.warning(f"world_slice: incident {incident_id} has no resolvable coords")
        return None
    return IncidentRef(
        id=str(_id),
        disaster_type=str(dtype),
        severity=int(severity) if severity is not None else 1,
        lat=float(lat),
        lng=float(lng),
        status=str(status) if status else "active",
        notes=str(notes) if notes else None,
    )


def _fetch_stations(conn: Any, lng_lat: tuple, *, k: int) -> List[StationRef]:
    lng, lat = lng_lat
    with conn.cursor() as cur:
        cur.execute(_STATIONS_SQL, (lng, lat, k))
        rows = cur.fetchall()
    out: List[StationRef] = []
    for r in rows:
        _id, name, slat, slng, dist, total, out_now = r
        if slat is None or slng is None or dist is None:
            continue
        out.append(StationRef(
            id=str(_id),
            name=str(name or ""),
            lat=float(slat),
            lng=float(slng),
            dist_m=float(dist),
            truck_count=int(total or 0),
            trucks_dispatched=int(out_now or 0),
        ))
    return out


def _fetch_cordons(conn: Any) -> List[CordonRef]:
    with conn.cursor() as cur:
        cur.execute(_CORDONS_SQL)
        rows = cur.fetchall()
    return [
        CordonRef(id=str(r[0]), reason=r[1], status=str(r[2]), raw_geometry=r[3])
        for r in rows
    ]


def _fetch_nearby_reports(
    conn: Any, lng_lat: tuple, *, radius_m: float, max_reports: int
) -> List[ReportRef]:
    lng, lat = lng_lat
    with conn.cursor() as cur:
        cur.execute(_NEARBY_REPORTS_SQL, (lng, lat, radius_m, max_reports))
        rows = cur.fetchall()
    out: List[ReportRef] = []
    for r in rows:
        _id, ts, transcript, rlat, rlng, itype, sev, casualties = r
        if rlat is None or rlng is None:
            continue
        out.append(ReportRef(
            id=str(_id),
            reported_at=ts,
            transcript=str(transcript or ""),
            lat=float(rlat),
            lng=float(rlng),
            incident_type=str(itype) if itype else None,
            severity=str(sev) if sev else None,
            casualties_mentioned=bool(casualties),
        ))
    return out
