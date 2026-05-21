"""Traffic watcher — fires wake-ups when congestion crosses thresholds.

Polls /api/traffic and tracks which segments are "heavy" (congestion_pct >= 0.6).
Pushes a wake-up when:
  - A segment newly crosses into heavy congestion
  - A segment newly drops out of heavy congestion
  - A segment newly has an incident text where it didn't before (or vice versa)

Each push carries the segment's centroid so area-dedup works.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from metrics import inc as _metric_inc
from wake_bus import WakeBus

logger = logging.getLogger(__name__)


TRAFFIC_POLL_SECONDS = float(os.environ.get("SENTINEL_TRAFFIC_POLL", "30"))
HEAVY_CONGESTION_THRESHOLD = float(os.environ.get("SENTINEL_TRAFFIC_THRESHOLD", "0.6"))


def _segment_state(seg: Dict[str, Any]) -> Tuple[bool, bool, Tuple[float, float]]:
    """(is_heavy, has_incident, (lat, lng))."""
    try:
        cong = float(seg.get("congestion_pct", 0))
    except (TypeError, ValueError):
        cong = 0.0
    is_heavy = cong >= HEAVY_CONGESTION_THRESHOLD
    has_incident = bool(seg.get("incident"))
    return (is_heavy, has_incident, (float(seg.get("lat", 0)), float(seg.get("lng", 0))))


async def _watch(api: Any) -> None:
    logger.info(
        f"Traffic watcher started (poll={TRAFFIC_POLL_SECONDS:.0f}s, "
        f"heavy threshold={HEAVY_CONGESTION_THRESHOLD})"
    )
    last_state: Dict[str, Tuple[bool, bool, Tuple[float, float]]] = {}
    first = True

    while True:
        try:
            try:
                payload = await api.get_traffic()
            except Exception as exc:
                logger.debug(f"traffic watcher: read failed: {exc}")
                payload = None

            segments = []
            if isinstance(payload, dict):
                segments = payload.get("segments", []) or []
            elif isinstance(payload, list):
                segments = payload

            new_state: Dict[str, Tuple[bool, bool, Tuple[float, float]]] = {}
            for seg in segments:
                if not isinstance(seg, dict):
                    continue
                sid = str(seg.get("segment_id") or seg.get("id") or seg.get("name") or "")
                if not sid:
                    continue
                new_state[sid] = _segment_state(seg)

            if not first:
                for sid, (heavy, incident, latlng) in new_state.items():
                    prev = last_state.get(sid)
                    if prev is None:
                        if heavy or incident:
                            _push("traffic:new_hotspot", latlng, sid)
                        continue
                    prev_heavy, prev_incident, _ = prev
                    if heavy != prev_heavy:
                        kind = "traffic:heavy_on" if heavy else "traffic:heavy_off"
                        await _push(kind, latlng, sid)
                    elif incident != prev_incident:
                        kind = "traffic:incident_on" if incident else "traffic:incident_off"
                        await _push(kind, latlng, sid)

            last_state = new_state
            first = False
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(f"traffic watcher iteration failed: {exc}")

        await asyncio.sleep(TRAFFIC_POLL_SECONDS)


async def _push(kind: str, latlng: Tuple[float, float], segment_id: str) -> None:
    _metric_inc(f"watcher.{kind}")
    area = {"lat": latlng[0], "lng": latlng[1]} if latlng != (0.0, 0.0) else None
    await WakeBus.push_all(kind, area=area, payload={"segment_id": segment_id})


def start(api: Any) -> asyncio.Task:
    return asyncio.create_task(_watch(api), name="traffic-watcher")
