"""Mock CCTV camera registry and image resolver.

When the operator triggers a disaster zone we spawn N fake "CCTV cameras"
around its centroid. Each camera is bound to a zone and tagged with the
zone's disaster_type + severity. When something (operator UI, AI agent)
asks for a camera's feed, we serve the matching pre-generated image from
`backend/disasters/{DisasterType}/sev{N}.{png|jpg}`.

The cameras themselves live in a process-local dict — no DB. Cameras are
removed when their zone is resolved (see clear_cameras_for_zone). The
backend restarting clears all cameras naturally, which matches the rest of
the simulator's in-memory ephemeral state (pending dispatches, etc.).

Power_Outage is deliberately unsupported — no folder exists, resolve_image
returns None, and spawn_cameras_for_zone short-circuits. Adding it later
is just dropping images into `disasters/Power_Outage/`.
"""
from __future__ import annotations

import math
import random
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# disasters/ sits next to this file.
_DISASTERS_DIR = Path(__file__).resolve().parent / "disasters"

# Process-local registry. Keyed by camera_id → camera dict.
_CAMERAS: Dict[str, Dict[str, Any]] = {}

# Zones we won't spawn cameras for. No image assets exist yet; the AI has
# no power-grid emergency service to dispatch even if it could see one.
_UNSUPPORTED_TYPES = {"Power_Outage"}

# Spawn parameters.
_CAMERAS_PER_ZONE = 3
_RING_MIN_M = 50
_RING_MAX_M = 250
# Search radius the agent uses when looking for a camera near a citizen
# report. 2 km is generous — Manhattan blocks are small.
_NEAREST_LOOKUP_RADIUS_M = 2000


# ── Image path resolution ───────────────────────────────────────────────


def resolve_image(disaster_type: str, severity: int) -> Optional[Path]:
    """Return the path to the mock CCTV image for this (type, severity),
    or None if no asset exists (e.g. Power_Outage, or a deleted file)."""
    if disaster_type in _UNSUPPORTED_TYPES:
        return None
    base = _DISASTERS_DIR / disaster_type / f"sev{severity}"
    for ext in ("png", "jpg"):
        p = base.with_suffix(f".{ext}")
        if p.is_file():
            return p
    return None


def image_mimetype(path: Path) -> str:
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


# ── Camera lifecycle ────────────────────────────────────────────────────


def spawn_cameras_for_zone(
    zone_id: str,
    disaster_type: str,
    severity: int,
    centroid: Optional[Tuple[float, float]],
    geometry_kind: str = "area",
) -> List[Dict[str, Any]]:
    """Drop mock cameras around a freshly triggered zone.

    Returns the spawned camera dicts. Empty list if the type is unsupported
    or no centroid could be resolved.
    """
    if disaster_type in _UNSUPPORTED_TYPES or centroid is None:
        return []
    if resolve_image(disaster_type, severity) is None:
        # No image to serve — pointless to spawn cameras the AI can't read.
        return []

    lat, lng = centroid
    if geometry_kind == "city":
        # Citywide events get a single camera at the centroid — fanning
        # out doesn't make sense.
        offsets = [(lat, lng)]
    else:
        offsets = [_jitter(lat, lng) for _ in range(_CAMERAS_PER_ZONE)]

    spawned: List[Dict[str, Any]] = []
    for clat, clng in offsets:
        cam_id = f"cam-{uuid.uuid4().hex[:8]}"
        cam = {
            "id": cam_id,
            "zone_id": zone_id,
            "lat": clat,
            "lng": clng,
            "disaster_type": disaster_type,
            "severity": severity,
        }
        _CAMERAS[cam_id] = cam
        spawned.append(cam)
    return spawned


def clear_cameras_for_zone(zone_id: str) -> int:
    """Remove every camera bound to this zone. Returns the count removed."""
    to_remove = [cid for cid, cam in _CAMERAS.items() if cam["zone_id"] == zone_id]
    for cid in to_remove:
        _CAMERAS.pop(cid, None)
    return len(to_remove)


def clear_all_cameras() -> int:
    """Wipe the registry — called by DELETE /api/disasters (Clear-all-zones)."""
    n = len(_CAMERAS)
    _CAMERAS.clear()
    return n


def get_camera(camera_id: str) -> Optional[Dict[str, Any]]:
    return _CAMERAS.get(camera_id)


def list_cameras(zone_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return every live camera, optionally filtered to one zone."""
    if zone_id is None:
        return list(_CAMERAS.values())
    return [c for c in _CAMERAS.values() if c["zone_id"] == zone_id]


def find_nearest_camera(
    lat: float, lng: float, max_distance_m: float = _NEAREST_LOOKUP_RADIUS_M
) -> Optional[Dict[str, Any]]:
    """Closest camera by great-circle distance, or None if none within range."""
    best: Optional[Dict[str, Any]] = None
    best_d = float("inf")
    for cam in _CAMERAS.values():
        d = _haversine_m(lat, lng, cam["lat"], cam["lng"])
        if d < best_d and d <= max_distance_m:
            best_d = d
            best = cam
    return best


# ── Geometry helpers ────────────────────────────────────────────────────


def centroid_from_geometry(geometry: Optional[Any]) -> Optional[Tuple[float, float]]:
    """Best-effort centroid (lat, lng) from a GeoJSON-ish dict.

    Handles Point, Polygon (uses first ring's bbox centre), and the
    `{type: "Circle", coordinates: [lng, lat], radius_metres: ...}` shape
    that Geoman emits. Returns None if nothing recognisable.
    """
    if not isinstance(geometry, dict):
        return None
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Point" and isinstance(coords, (list, tuple)) and len(coords) >= 2:
        lng, lat = coords[0], coords[1]
        return (float(lat), float(lng))
    if gtype == "Polygon" and isinstance(coords, list) and coords and isinstance(coords[0], list):
        ring = coords[0]
        xs = [pt[0] for pt in ring if isinstance(pt, (list, tuple)) and len(pt) >= 2]
        ys = [pt[1] for pt in ring if isinstance(pt, (list, tuple)) and len(pt) >= 2]
        if xs and ys:
            return ((min(ys) + max(ys)) / 2.0, (min(xs) + max(xs)) / 2.0)
    if gtype == "Circle" and isinstance(coords, (list, tuple)) and len(coords) >= 2:
        return (float(coords[1]), float(coords[0]))
    return None


def _jitter(lat: float, lng: float) -> Tuple[float, float]:
    """Random point in the 50-250 m ring around (lat, lng)."""
    bearing = random.uniform(0, 2 * math.pi)
    distance = random.uniform(_RING_MIN_M, _RING_MAX_M)
    # ~111 320 m per degree of latitude; longitude shrinks by cos(lat).
    dlat = (distance * math.cos(bearing)) / 111_320.0
    dlng = (distance * math.sin(bearing)) / (111_320.0 * max(math.cos(math.radians(lat)), 1e-6))
    return (lat + dlat, lng + dlng)


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
