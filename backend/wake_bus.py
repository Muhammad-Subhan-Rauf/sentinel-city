"""Event-driven wake-up bus for the AI orchestrator.

Instead of polling every 90s, the orchestrator's loops sleep on a queue. They
wake when:
  - A citizen report (or burst) arrives  (POST /api/citizen-report)
  - The weather watcher detects a major regional change
  - The traffic watcher detects a major congestion change
  - The SLA watchdog fires (dispatch SLA or deadman)
  - A long-interval fallback ticks (so monitoring keeps an eye on stuck incidents)

Semantics:
  - **Debounce 5s on cold queue**: first event after AI was idle starts a 5s
    window; more events arriving during the window get folded in.
  - **No debounce when catching up**: if events are already queued when
    next_wakeup() is called (AI just finished a run and more events came in
    during it), return immediately so the AI catches up fast.
  - **Area dedup**: wake-ups within DEDUP_RADIUS_M of an already-pending
    wake-up are merged into the existing entry instead of stacking.
  - **Per-loop instance**: detection and monitoring each have their own bus,
    so they don't steal events from each other.
  - **Push-to-all**: `push_all()` fans out to every registered bus.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from metrics import inc as _metric_inc

logger = logging.getLogger(__name__)


DEBOUNCE_SECONDS = float(os.environ.get("SENTINEL_WAKE_DEBOUNCE", "5"))
DEDUP_RADIUS_M = float(os.environ.get("SENTINEL_WAKE_DEDUP_M", "1000"))
# Background heartbeat — fires if nothing has woken the loop in this long.
# Keeps monitoring from rotting silently if all watchers go quiet.
FALLBACK_SECONDS_DEFAULT = float(os.environ.get("SENTINEL_WAKE_FALLBACK", "300"))


def _haversine_m(a: Dict[str, float], b: Dict[str, float]) -> float:
    """Distance in meters between two {lat, lng} dicts."""
    R = 6371000.0
    lat1, lng1 = math.radians(a["lat"]), math.radians(a["lng"])
    lat2, lng2 = math.radians(b["lat"]), math.radians(b["lng"])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


@dataclass
class _PendingEvent:
    source: str
    area: Optional[Dict[str, float]]  # {lat, lng} or None
    payload: Dict[str, Any] = field(default_factory=dict)
    merged_sources: List[str] = field(default_factory=list)
    merged_count: int = 1


@dataclass
class Wakeup:
    """Consolidated wake-up record returned to the orchestrator."""
    sources: List[str]
    events: List[_PendingEvent]
    area: Optional[Dict[str, float]]
    fallback: bool = False  # True if this fired from the heartbeat timeout

    def summary(self) -> str:
        """Short human/agent-readable description of why the AI was woken."""
        if self.fallback:
            return "heartbeat (no external events; periodic check)"
        if not self.events:
            return "unknown wake"
        srcs = ", ".join(sorted(set(self.sources)))
        total = sum(e.merged_count for e in self.events)
        return f"{total} event(s) from {srcs}; {len(self.events)} clusters"

    @property
    def change_driven(self) -> bool:
        """True when at least one source already did its own change-detection
        (weather/traffic watchers, SLA watchdog). Such wakes should bypass
        the orchestrator's fingerprint dedup — the fingerprint hashes only
        disasters+reports, so a real weather/traffic change leaves it
        unchanged and the agent would never run otherwise."""
        for s in self.sources:
            if s.startswith(("weather:", "traffic:", "sla:")):
                return True
        return False


class WakeBus:
    """Per-loop wake-up queue with debounce + dedup."""

    _instances: Dict[str, "WakeBus"] = {}

    def __init__(self, label: str):
        self.label = label
        self._buffer: List[_PendingEvent] = []
        self._event = asyncio.Event()
        # Synchronization lock around buffer mutations
        self._lock = asyncio.Lock()

    @classmethod
    def for_label(cls, label: str) -> "WakeBus":
        if label not in cls._instances:
            cls._instances[label] = cls(label)
        return cls._instances[label]

    @classmethod
    def all_buses(cls) -> List["WakeBus"]:
        return list(cls._instances.values())

    @classmethod
    async def push_all(
        cls,
        source: str,
        *,
        area: Optional[Dict[str, float]] = None,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Fan out a wake-up to every registered bus (detection AND monitoring)."""
        if not cls._instances:
            # No subscribers yet — nothing to wake. Cheap no-op so callers
            # (e.g. FastAPI endpoints) don't have to worry about ordering.
            _metric_inc(f"wake_bus.dropped_no_subscribers.{source}")
            return
        for inst in cls._instances.values():
            await inst.push(source, area=area, payload=payload)

    async def push(
        self,
        source: str,
        *,
        area: Optional[Dict[str, float]] = None,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Push a single wake-up event to this bus. Applies area dedup."""
        payload = payload or {}
        async with self._lock:
            merged = False
            if area:
                for existing in self._buffer:
                    if existing.area is None:
                        continue
                    if _haversine_m(existing.area, area) <= DEDUP_RADIUS_M:
                        existing.merged_sources.append(source)
                        existing.merged_count += 1
                        merged = True
                        _metric_inc(f"wake_bus.{self.label}.merged.{source}")
                        break
            if not merged:
                self._buffer.append(_PendingEvent(source=source, area=area, payload=payload))
                _metric_inc(f"wake_bus.{self.label}.pushed.{source}")
            self._event.set()

    async def next_wakeup(self, *, fallback_seconds: float = FALLBACK_SECONDS_DEFAULT) -> Wakeup:
        """Block until a wake-up fires (or fallback timeout). Returns the
        consolidated wakeup. See module docstring for debounce semantics."""

        # Catch-up path: if events arrived while AI was busy, drain immediately
        async with self._lock:
            if self._buffer:
                _metric_inc(f"wake_bus.{self.label}.catchup")
                return self._drain_locked(fallback=False)
            self._event.clear()

        # Cold path: wait for first event OR fallback heartbeat
        try:
            await asyncio.wait_for(self._event.wait(), timeout=fallback_seconds)
        except asyncio.TimeoutError:
            _metric_inc(f"wake_bus.{self.label}.fallback_heartbeat")
            return Wakeup(sources=[], events=[], area=None, fallback=True)

        # Got at least one event — start debounce window so more can pile in
        _metric_inc(f"wake_bus.{self.label}.cold_wake")
        await asyncio.sleep(DEBOUNCE_SECONDS)

        async with self._lock:
            return self._drain_locked(fallback=False)

    def _drain_locked(self, fallback: bool) -> Wakeup:
        """Buffer must be held. Drain into a Wakeup."""
        events = list(self._buffer)
        self._buffer.clear()
        self._event.clear()
        sources: List[str] = []
        for e in events:
            sources.append(e.source)
            sources.extend(e.merged_sources)
        area = events[0].area if events and events[0].area else None
        return Wakeup(sources=sources, events=events, area=area, fallback=fallback)


def reset_for_test() -> None:
    """Test-only: wipe all registered buses."""
    WakeBus._instances.clear()
