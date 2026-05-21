"""Weather watcher — fires wake-ups on major regional changes.

The /api/weather/regions endpoint returns one entry per weather-bending
disaster. A "major change" is:
  - A new region appearing
  - A region disappearing
  - A region's severity changing
  - The citywide override appearing or disappearing

For each major change we push a wake-up with `area = region.centroid` so
the bus can apply area-dedup. Citywide changes push with area=None.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from metrics import inc as _metric_inc
from wake_bus import WakeBus

logger = logging.getLogger(__name__)


WEATHER_POLL_SECONDS = float(os.environ.get("SENTINEL_WEATHER_POLL", "30"))


def _signature(regions: List[Dict[str, Any]]) -> Dict[str, Tuple[int, Optional[Tuple[float, float]]]]:
    """Map event_id → (severity, centroid_tuple). Used for delta detection."""
    sig: Dict[str, Tuple[int, Optional[Tuple[float, float]]]] = {}
    for r in regions or []:
        eid = str(r.get("event_id", ""))
        if not eid:
            continue
        sev = int(r.get("severity") or 0)
        c = r.get("centroid")
        centroid_t = None
        if isinstance(c, dict) and c.get("lat") is not None:
            centroid_t = (float(c["lat"]), float(c["lng"]))
        sig[eid] = (sev, centroid_t)
    return sig


def _diff(old: Dict[str, Tuple[int, Optional[Tuple[float, float]]]],
          new: Dict[str, Tuple[int, Optional[Tuple[float, float]]]]) -> List[Tuple[str, str, Optional[Tuple[float, float]]]]:
    """Return [(event_id, change_kind, centroid)] for each change."""
    changes: List[Tuple[str, str, Optional[Tuple[float, float]]]] = []
    for eid, (sev, c) in new.items():
        if eid not in old:
            changes.append((eid, "appeared", c))
        elif old[eid][0] != sev:
            changes.append((eid, "severity_changed", c))
    for eid in old.keys() - new.keys():
        changes.append((eid, "disappeared", old[eid][1]))
    return changes


async def _watch(api: Any) -> None:
    """Poll /api/weather/regions and push wake-ups on major changes."""
    logger.info(f"Weather watcher started (poll={WEATHER_POLL_SECONDS:.0f}s)")
    last_sig: Dict[str, Tuple[int, Optional[Tuple[float, float]]]] = {}
    last_citywide: Optional[str] = None
    first = True

    while True:
        try:
            try:
                payload = await api.get_weather_regions()
            except Exception as exc:
                logger.debug(f"weather watcher: regions endpoint unavailable: {exc}")
                payload = {}

            regions = (payload or {}).get("regions", [])
            global_block = (payload or {}).get("global", {})
            citywide_event = (global_block.get("driver") or {}).get("event_id") if global_block else None

            sig = _signature(regions)
            changes = _diff(last_sig, sig)
            citywide_changed = (citywide_event != last_citywide)

            if not first and (changes or citywide_changed):
                # Push one wake per changed region (area-deduped by the bus)
                for eid, kind, centroid in changes:
                    area = {"lat": centroid[0], "lng": centroid[1]} if centroid else None
                    _metric_inc(f"watcher.weather.{kind}")
                    await WakeBus.push_all(
                        f"weather:{kind}",
                        area=area,
                        payload={"event_id": eid, "kind": kind},
                    )
                if citywide_changed:
                    _metric_inc("watcher.weather.citywide_changed")
                    await WakeBus.push_all(
                        "weather:citywide_changed",
                        area=None,
                        payload={"from": last_citywide, "to": citywide_event},
                    )

            last_sig = sig
            last_citywide = citywide_event
            first = False
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(f"weather watcher iteration failed: {exc}")

        await asyncio.sleep(WEATHER_POLL_SECONDS)


def start(api: Any) -> asyncio.Task:
    """Spawn the watcher as a background task. Returns the handle."""
    return asyncio.create_task(_watch(api), name="weather-watcher")
