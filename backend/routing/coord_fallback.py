"""Deterministic dispatch-target resolver.

When Gemini hands us ``target={lat:0, lng:0}``, the original code re-prompted
Gemini for real coordinates (tools.py:_resolve_target_via_gemini) — one extra
LLM call per occurrence. We can do better: the incident record already carries
its location in `area_geometry`. Resolve from that, falling back to the
in-memory AgentState's incident.location, and only return None if both miss.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _centroid_of_polygon(coords: List[List[List[float]]]) -> Optional[Dict[str, float]]:
    """GeoJSON Polygon: coordinates = [outer_ring, hole1, hole2, ...]. Each
    ring is a list of [lng, lat] pairs. Return centroid of the outer ring
    (cheap arithmetic mean — good enough for dispatch routing)."""
    if not coords or not coords[0]:
        return None
    ring = coords[0]
    pts = [p for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
    if not pts:
        return None
    avg_lng = sum(float(p[0]) for p in pts) / len(pts)
    avg_lat = sum(float(p[1]) for p in pts) / len(pts)
    return {"lat": avg_lat, "lng": avg_lng}


def _coords_from_geometry(geometry: Any) -> Optional[Dict[str, float]]:
    """Extract a (lat, lng) target from a GeoJSON-shaped dict."""
    if not isinstance(geometry, dict):
        return None
    gtype = (geometry.get("type") or "").lower()
    coords = geometry.get("coordinates")
    if coords is None:
        return None
    try:
        if gtype == "point" and len(coords) >= 2:
            return {"lat": float(coords[1]), "lng": float(coords[0])}
        if gtype == "polygon":
            return _centroid_of_polygon(coords)
        if gtype == "multipolygon" and coords:
            return _centroid_of_polygon(coords[0])
    except (TypeError, ValueError, IndexError) as exc:
        logger.debug(f"coord extraction failed for geometry type={gtype}: {exc}")
    return None


def _is_invalid(target: Any) -> bool:
    if not isinstance(target, dict):
        return True
    try:
        return abs(float(target.get("lat", 0))) < 0.001 and abs(float(target.get("lng", 0))) < 0.001
    except (TypeError, ValueError):
        return True


async def resolve_target_deterministic(
    incident_id: Optional[str],
    api: Any,
    state: Optional[Any] = None,
) -> Optional[Dict[str, float]]:
    """Resolve a dispatch target without any LLM call.

    Lookup order (favors AI-visible estimates over ground truth so dispatch
    accuracy reflects what the AI actually knows — no cheating):
      1. IncidentState.location_estimate (AI's last triangulation)
      2. Triangulate fresh from citizen reports (uses the noisy algorithm)
      3. ONLY as a final safety net (so dispatch always succeeds): the
         server-side ground-truth location/area_geometry.
    """
    if not incident_id:
        return None

    # 1. Cached estimate from a prior triangulate_incident call
    if state is not None and getattr(state, "active_incidents", None):
        inc = state.active_incidents.get(incident_id)
        if inc is not None:
            est = getattr(inc, "location_estimate", None) or {}
            try:
                if est:
                    lat = float(est.get("lat", 0))
                    lng = float(est.get("lng", 0))
                    if not (abs(lat) < 0.001 and abs(lng) < 0.001):
                        return {"lat": lat, "lng": lng}
            except (TypeError, ValueError):
                pass

    # 2. Trigger a fresh triangulation (still noisy — no ground truth)
    try:
        from routing.triangulation import triangulate
        est = await triangulate(api, incident_id=incident_id, state=state)
        if est and est.get("lat") is not None and est.get("confidence", 0) >= 0.3:
            return {"lat": float(est["lat"]), "lng": float(est["lng"])}
    except Exception as exc:
        logger.warning(f"coord_fallback triangulation failed for {incident_id}: {exc}")

    # 3. Last-resort ground truth so dispatch never silently no-ops
    if state is not None and getattr(state, "active_incidents", None):
        inc = state.active_incidents.get(incident_id)
        if inc is not None:
            loc = getattr(inc, "location", None) or {}
            try:
                lat = float(loc.get("lat", 0))
                lng = float(loc.get("lng", 0))
                if not (abs(lat) < 0.001 and abs(lng) < 0.001):
                    logger.warning(
                        f"coord_fallback fell through to ground truth for {incident_id} — "
                        "AI never produced a triangulated estimate"
                    )
                    return {"lat": lat, "lng": lng}
            except (TypeError, ValueError):
                pass
    try:
        disasters = await api.get_disasters()
        items = disasters if isinstance(disasters, list) else (disasters or {}).get("disasters", [])
        match = next((d for d in items if d.get("id") == incident_id), None)
        if match:
            target = _coords_from_geometry(match.get("area_geometry"))
            if target and not _is_invalid(target):
                return target
    except Exception as exc:
        logger.warning(f"coord_fallback API path failed for {incident_id}: {exc}")

    return None
