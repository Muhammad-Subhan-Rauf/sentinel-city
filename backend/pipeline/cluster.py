"""PostGIS-backed spatio-temporal clustering of citizen reports.

Given one "seed" report (the one that just arrived), find every other
not-yet-declared report within a space + time window of the same
``incident_type``. This is the cluster the policy engine evaluates for
``should_declare``.

Per the plan's Mandate 3: clustering is pure SQL (PostGIS ``ST_DWithin``)
plus a tiny amount of Python post-processing. No O(N²) Python loops over
report rows.

Per the plan's Trap 1: ``cluster_confidence`` is computed here from
cluster density / count / time-tightness / casualty signal — NOT from
the LLM's self-rated ``confidence``. The LLM extraction's confidence is
recorded for debugging but never gates a decision.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional

logger = logging.getLogger(__name__)


# Tunables — surfaced as module constants so tests + tuning live in one place.
#
# Radius was 100m initially; widened to 300m because the citizen sim spreads
# reports across the entire disaster zone (typically 300–500m). At 100m a
# single seed report often only had 0–1 neighbors, so the cluster never
# reached MIN_REPORTS_TO_DECLARE and the pipeline sat in "only observing"
# limbo. 300m matches the typical disaster footprint while still being tight
# enough that distinct nearby incidents don't merge.
DEFAULT_RADIUS_M = 300.0
DEFAULT_TIME_WINDOW_S = 300.0

# Count threshold below which we never declare regardless of how tight the
# cluster is. Lowered from 3 to 2 because the simulation generates corroborating
# reports fast — 2 within 5 minutes is already strong evidence.
MIN_REPORTS_TO_DECLARE = 2
MIN_CLUSTER_CONFIDENCE = 0.5

# Attach-to-existing radius (meters). When a fresh report's cluster doesn't
# pass the declare threshold but the report sits near an already-declared
# active same-type incident, attach it to that incident rather than leaving
# it floating. Same value as the declare-dedup radius for symmetry.
ATTACH_TO_EXISTING_RADIUS_M = 800.0


@dataclass
class ClusteredReport:
    """A row from citizen_reports already filtered into the cluster."""
    id: str
    event_id: Optional[str]
    reported_at: datetime
    incident_type: str
    severity: str
    transcript: str
    lat: float
    lng: float
    casualties_mentioned: bool


@dataclass
class ReportCluster:
    """The output of ``find_cluster``. Pure data; downstream functions are pure."""
    seed_report_id: str
    reports: List[ClusteredReport] = field(default_factory=list)
    incident_type: str = "other"
    centroid_lat: float = 0.0
    centroid_lng: float = 0.0
    time_span_seconds: float = 0.0
    radius_m: float = 0.0

    @property
    def n_reports(self) -> int:
        return len(self.reports)

    @property
    def any_casualties(self) -> bool:
        return any(r.casualties_mentioned for r in self.reports)


# ── PostGIS query ───────────────────────────────────────────────────────


_CLUSTER_SQL = """
SELECT
    b.id,
    b.event_id,
    b.reported_at,
    b.nlu_extraction->>'incident_type' AS incident_type,
    b.nlu_extraction->>'severity'      AS severity,
    b.transcript,
    ST_Y(b.geom::geometry)             AS lat,
    ST_X(b.geom::geometry)             AS lng,
    COALESCE((b.nlu_extraction->>'casualties_mentioned')::boolean, FALSE) AS casualties_mentioned
FROM citizen_reports b
JOIN citizen_reports seed ON seed.id = %s
WHERE b.declared_incident_id IS NULL
  AND b.geom IS NOT NULL
  AND b.nlu_extraction IS NOT NULL
  AND b.nlu_extraction->>'incident_type' = seed.nlu_extraction->>'incident_type'
  AND ST_DWithin(b.geom, seed.geom, %s)
  AND abs(EXTRACT(EPOCH FROM (b.reported_at - seed.reported_at))) <= %s
ORDER BY b.reported_at ASC;
"""


def find_cluster(
    conn: Any,
    seed_report_id: str,
    *,
    radius_m: float = DEFAULT_RADIUS_M,
    time_window_s: float = DEFAULT_TIME_WINDOW_S,
) -> Optional[ReportCluster]:
    """Run the PostGIS spatio-temporal join and return a ReportCluster.

    Returns None if the seed report doesn't exist, has no geom / no
    nlu_extraction, or yields zero rows (which shouldn't happen since the
    seed is in the same table — but be defensive).

    ``conn`` is a psycopg2 connection. The query runs in a fresh cursor;
    the caller owns the transaction boundary.
    """
    with conn.cursor() as cur:
        cur.execute(_CLUSTER_SQL, (seed_report_id, radius_m, time_window_s))
        rows = cur.fetchall()

    if not rows:
        return None

    reports: List[ClusteredReport] = []
    for r in rows:
        rid, eid, reported_at, itype, sev, transcript, lat, lng, casualties = r
        if lat is None or lng is None or itype is None:
            continue
        reports.append(
            ClusteredReport(
                id=str(rid),
                event_id=str(eid) if eid is not None else None,
                reported_at=reported_at,
                incident_type=str(itype),
                severity=str(sev) if sev else "low",
                transcript=str(transcript or ""),
                lat=float(lat),
                lng=float(lng),
                casualties_mentioned=bool(casualties),
            )
        )

    if not reports:
        return None

    return _summarize(seed_report_id, reports)


def _summarize(seed_report_id: str, reports: List[ClusteredReport]) -> ReportCluster:
    """Compute centroid, radius, and time span over the cluster rows."""
    n = len(reports)
    centroid_lat = sum(r.lat for r in reports) / n
    centroid_lng = sum(r.lng for r in reports) / n

    radius_m = max(
        _haversine_m(centroid_lat, centroid_lng, r.lat, r.lng) for r in reports
    )

    earliest = min(r.reported_at for r in reports)
    latest = max(r.reported_at for r in reports)
    time_span_s = (latest - earliest).total_seconds()

    # Majority vote on incident_type. Since the SQL filter requires same
    # type as seed, this is effectively just reports[0].incident_type, but
    # we compute it explicitly so future relaxations of the filter still work.
    type_counts: dict[str, int] = {}
    for r in reports:
        type_counts[r.incident_type] = type_counts.get(r.incident_type, 0) + 1
    incident_type = max(type_counts.items(), key=lambda kv: kv[1])[0]

    return ReportCluster(
        seed_report_id=seed_report_id,
        reports=reports,
        incident_type=incident_type,
        centroid_lat=centroid_lat,
        centroid_lng=centroid_lng,
        time_span_seconds=time_span_s,
        radius_m=radius_m,
    )


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Earth-surface distance in meters."""
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ── Confidence (Trap 1: derived server-side, NOT from LLM self-rating) ─


def cluster_confidence(cluster: ReportCluster) -> float:
    """Derived confidence in [0, 1].

    Composition (sums to ≤ 1.0):
      - count signal     (≤ 0.70): 1 report = 0.14, 3 = 0.42, 5+ = 0.70
      - spatial bonus    (≤ 0.15): tighter radius = more
      - temporal bonus   (≤ 0.10): tighter time-span = more
      - casualty signal  (≤ 0.15): hard signal that something real is happening

    The thresholds in MIN_REPORTS_TO_DECLARE + MIN_CLUSTER_CONFIDENCE are
    tuned empirically per plan §Verification step 8 (calibration). Treat
    the defaults here as a starting point.
    """
    n = cluster.n_reports
    if n == 0:
        return 0.0

    # Count: linear up to 5 reports, then capped.
    count = min(n / 5.0, 1.0) * 0.70

    # Spatial tightness: smaller radius = real cluster, not noise.
    if cluster.radius_m <= 50:
        spatial = 0.15
    elif cluster.radius_m <= 100:
        spatial = 0.10
    elif cluster.radius_m <= 200:
        spatial = 0.05
    else:
        spatial = 0.0

    # Temporal tightness: arrived in a burst, not over hours.
    if cluster.time_span_seconds <= 60:
        temporal = 0.10
    elif cluster.time_span_seconds <= 180:
        temporal = 0.05
    else:
        temporal = 0.0

    # Casualty hard signal: if any report says "trapped" or "injured",
    # that's not LLM-self-rated, it's an extracted fact.
    casualty = 0.15 if cluster.any_casualties else 0.0

    return min(count + spatial + temporal + casualty, 1.0)
