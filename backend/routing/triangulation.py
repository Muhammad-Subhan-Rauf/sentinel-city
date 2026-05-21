"""Citizen-report triangulation.

Two modes, both simple:

  1. **incident_id mode** — every citizen report carries `event_id`. Filter to
     reports with the matching event_id, take their centroid, add a small
     Gaussian jitter (so the AI never sees "perfect" coords from civilian
     reports). Confidence scales with report count. THIS IS THE COMMON PATH.

  2. **search_bbox mode** — for detection: filter reports inside the bbox,
     greedy-cluster by haversine (largest cluster wins), take that cluster's
     centroid. Used when we don't yet know which incident the reports refer
     to (i.e. before declare_incident).

Earlier versions did seed-based 3 km filtering for the incident_id path. That
was throwing nulls when the AI's deduped incident had a stale `location_estimate`
far from where citizens were actually reporting. event_id is the authoritative
filter — geometry was the wrong primary key.
"""

from __future__ import annotations

import logging
import math
import os
import random
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from baseline.rule_engine import haversine
from metrics import inc as _metric_inc
from metrics import observe as _metric_observe

logger = logging.getLogger(__name__)


# Reports older than this are ignored (fresh signals only).
RECENT_WINDOW_SECONDS = float(os.environ.get("SENTINEL_TRIANGULATE_WINDOW", "600"))
# Minimum uncertainty so the AI never gets a "perfect" coordinate from civilians.
UNCERTAINTY_FLOOR_M = 40.0
# Cluster radius for the search_bbox (detection) path.
CLUSTER_RADIUS_M = 300.0
# Deterministic mode for tests.
_DETERMINISTIC = False


def set_deterministic_for_test(flag: bool) -> None:
    global _DETERMINISTIC
    _DETERMINISTIC = bool(flag)


def _parse_ts(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value)
    try:
        if s.endswith("Z"):
            s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _within_window(report: Dict[str, Any], cutoff_ts: float) -> bool:
    for key in ("reported_at", "created_at", "timestamp"):
        ts = _parse_ts(report.get(key))
        if ts > 0:
            return ts >= cutoff_ts
    return True  # no timestamp — keep, can't disqualify


def _coords_of(report: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    loc = report.get("location") or {}
    if isinstance(loc, dict):
        try:
            lat = float(loc.get("lat", 0))
            lng = float(loc.get("lng", 0))
            if not (abs(lat) < 0.001 and abs(lng) < 0.001):
                return (lat, lng)
        except (TypeError, ValueError):
            pass
    return None


def _spread_m(points: List[Tuple[float, float]]) -> float:
    """Max pairwise distance — proxy for cluster tightness."""
    n = len(points)
    if n < 2:
        return 0.0
    mx = 0.0
    # O(N²) — fine for the small N we handle here (≤ 200)
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine(points[i][0], points[i][1], points[j][0], points[j][1])
            if d > mx:
                mx = d
    return mx


def _confidence_for(n: int, spread_m: float) -> float:
    """0..1 confidence. Dominated by report count; spread only penalises when
    citizens are reporting from genuinely-wide-apart locations (>1 km).
    Earlier curve over-penalised legit fires that had spread across ~1 km
    of city blocks — 41 reports came out at 0.28 because spread > 1.5 km.
    """
    if n == 0:
        return 0.0
    # Logistic-ish: n=1→0.15, n=3→0.39, n=5→0.56, n=10→0.80, n=20+→0.95
    base = 1.0 - (0.85 ** n)
    base = min(0.95, max(0.05, base))
    if spread_m > 1000:
        base *= max(0.5, 1.0 - (spread_m - 1000) / 3000.0)
    return round(min(0.95, base), 2)


def _uncertainty_m(n: int, spread_m: float) -> float:
    """Approximate uncertainty radius; never below the floor."""
    if n == 0:
        return 2000.0
    if n == 1:
        return max(UNCERTAINTY_FLOOR_M, 600.0)
    spread_contrib = spread_m / max(2, n - 1)
    floor_contrib = 250.0 / math.sqrt(n)
    return max(UNCERTAINTY_FLOOR_M, spread_contrib + floor_contrib)


def _centroid(points: List[Tuple[float, float]]) -> Tuple[float, float]:
    avg_lat = sum(p[0] for p in points) / len(points)
    avg_lng = sum(p[1] for p in points) / len(points)
    return avg_lat, avg_lng


def _jittered(lat: float, lng: float, uncertainty_m: float) -> Tuple[float, float]:
    """Centroid + Gaussian jitter scaled to uncertainty/3."""
    if _DETERMINISTIC:
        return lat, lng
    sigma_m = uncertainty_m / 3.0
    dLat = random.gauss(0, sigma_m / 111320.0)
    dLng = random.gauss(0, sigma_m / (111320.0 * max(math.cos(math.radians(lat)), 1e-6)))
    return lat + dLat, lng + dLng


def _largest_cluster(points: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """Greedy clustering for the bbox path: for each point, count those within
    CLUSTER_RADIUS_M; keep the largest such group."""
    if not points:
        return []
    best: List[Tuple[float, float]] = []
    for seed in points:
        cluster = [p for p in points if haversine(seed[0], seed[1], p[0], p[1]) <= CLUSTER_RADIUS_M]
        if len(cluster) > len(best):
            best = cluster
    return best


async def triangulate(
    api: Any,
    *,
    incident_id: Optional[str] = None,
    search_bbox: Optional[Dict[str, float]] = None,
    state: Optional[Any] = None,
) -> Dict[str, Any]:
    """Triangulate an incident's location from citizen reports.

    incident_id given → centroid of all reports tagged with that event_id.
    search_bbox given → cluster reports inside the bbox; return cluster centroid.
    Both add small noise so the AI never sees a "perfect" civilian-sourced coord.

    Always returns a dict with the same shape; on insufficient signal returns
    confidence=0.0 so the agent can defer instead of crashing.
    """
    started = time.time()
    _metric_inc("triangulation.calls_total")

    reports_raw = await api.get_citizen_reports()
    if isinstance(reports_raw, dict):
        reports_raw = reports_raw.get("reports", [])
    reports_raw = reports_raw or []

    cutoff = time.time() - RECENT_WINDOW_SECONDS

    # Window filter (always applies)
    window_filtered = [r for r in reports_raw if isinstance(r, dict) and _within_window(r, cutoff)]

    # ── incident_id path: filter by event_id, take centroid ──────────────
    if incident_id:
        target_id = str(incident_id)
        matched = [r for r in window_filtered if str(r.get("event_id", "")) == target_id]
        points: List[Tuple[float, float]] = []
        sample_transcripts: List[str] = []
        for r in matched:
            coords = _coords_of(r)
            if coords is None:
                continue
            points.append(coords)
            t = str(r.get("transcript", "")).strip()
            if t and len(sample_transcripts) < 3:
                sample_transcripts.append(t[:140])
        if not points:
            _metric_inc("triangulation.no_signal")
            return _empty_result(
                f"No recent reports tagged event_id={target_id}. "
                "Either no citizen has called about this incident in the last "
                f"{int(RECENT_WINDOW_SECONDS)}s, or the incident_id is wrong."
            )
        spread = _spread_m(points)
        cx, cy = _centroid(points)
        unc = _uncertainty_m(len(points), spread)
        lat, lng = _jittered(cx, cy, unc)
        estimate = _make_estimate(lat, lng, unc, _confidence_for(len(points), spread),
                                   len(points), len(points), spread, sample_transcripts)
        _cache_on_state(state, target_id, estimate)
        _metric_inc("triangulation.success")
        _metric_observe("triangulation.confidence", estimate["confidence"])
        _metric_observe("triangulation.n_reports", len(points))
        _metric_observe("triangulation.latency_seconds", time.time() - started)
        return estimate

    # ── search_bbox path: cluster inside bbox, take largest cluster ───────
    if search_bbox:
        try:
            min_lat = float(search_bbox.get("min_lat", -90))
            max_lat = float(search_bbox.get("max_lat", 90))
            min_lng = float(search_bbox.get("min_lng", -180))
            max_lng = float(search_bbox.get("max_lng", 180))
        except (TypeError, ValueError):
            return _empty_result("Invalid search_bbox shape; expected {min_lat,max_lat,min_lng,max_lng}.")

        candidates: List[Tuple[float, float]] = []
        sample_transcripts: List[str] = []
        for r in window_filtered:
            coords = _coords_of(r)
            if coords is None:
                continue
            if not (min_lat <= coords[0] <= max_lat and min_lng <= coords[1] <= max_lng):
                continue
            candidates.append(coords)
            t = str(r.get("transcript", "")).strip()
            if t and len(sample_transcripts) < 3:
                sample_transcripts.append(t[:140])
        if not candidates:
            _metric_inc("triangulation.no_signal")
            return _empty_result(
                "No recent citizen reports inside the search bbox. "
                "Widen the bbox, or wait one tick for fresh reports."
            )
        cluster = _largest_cluster(candidates) or candidates
        spread = _spread_m(cluster)
        cx, cy = _centroid(cluster)
        unc = _uncertainty_m(len(cluster), spread)
        lat, lng = _jittered(cx, cy, unc)
        estimate = _make_estimate(lat, lng, unc, _confidence_for(len(cluster), spread),
                                   len(cluster), len(candidates), spread, sample_transcripts)
        _metric_inc("triangulation.success")
        _metric_observe("triangulation.confidence", estimate["confidence"])
        _metric_observe("triangulation.n_reports", len(cluster))
        _metric_observe("triangulation.latency_seconds", time.time() - started)
        return estimate

    # Neither path specified
    return _empty_result(
        "triangulate_incident requires either incident_id or search_bbox."
    )


# ── small helpers (kept out of the body so the two paths read cleanly) ──

def _empty_result(note: str) -> Dict[str, Any]:
    return {
        "lat": None,
        "lng": None,
        "uncertainty_m": None,
        "confidence": 0.0,
        "n_reports": 0,
        "n_candidates_in_area": 0,
        "cluster_spread_m": 0.0,
        "sample_transcripts": [],
        "note": note,
    }


def _make_estimate(lat, lng, unc, conf, n_reports, n_candidates, spread, transcripts):
    return {
        "lat": round(lat, 6),
        "lng": round(lng, 6),
        "uncertainty_m": round(unc, 1),
        "confidence": conf,
        "n_reports": n_reports,
        "n_candidates_in_area": n_candidates,
        "cluster_spread_m": round(spread, 1),
        "sample_transcripts": transcripts,
    }


def _cache_on_state(state, incident_id, estimate):
    """Cache the (lat, lng) on IncidentState.location_estimate so coord_fallback
    and follow-up triangulations refine the same incident's estimate."""
    if state is None or not incident_id:
        return
    try:
        inc_state = getattr(state, "active_incidents", {}).get(incident_id)
        if inc_state is not None:
            inc_state.location_estimate = {"lat": estimate["lat"], "lng": estimate["lng"]}
    except Exception:
        pass
