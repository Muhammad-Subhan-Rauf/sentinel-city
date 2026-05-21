"""Process-wide counters/gauges for the Sentinel-City demo dashboard.

Pure in-process state. Read by /api/metrics (mounted in main.py) and surfaced
in AILogsDrawer so the demo audience can see token savings + safety verdicts
in real time.

Three primitives:
  inc(name)         – monotonic counter (++)
  set_gauge(name)   – arbitrary current value (set, not added)
  observe(name)     – distribution sample (mean + count + last)

Thread-/async-safe enough for the orchestrator: writes are GIL-atomic on dict
slot replacement; readers get a shallow copy via snapshot().
"""

from __future__ import annotations

import time
from threading import Lock
from typing import Any, Dict

_COUNTERS: Dict[str, int] = {}
_GAUGES: Dict[str, float] = {}
_DISTS: Dict[str, Dict[str, float]] = {}
_LOCK = Lock()

_STARTED_AT = time.time()


def inc(name: str, n: int = 1) -> None:
    with _LOCK:
        _COUNTERS[name] = _COUNTERS.get(name, 0) + n


def set_gauge(name: str, value: float) -> None:
    with _LOCK:
        _GAUGES[name] = float(value)


def observe(name: str, value: float) -> None:
    """Record a sample in a distribution. Keeps running mean + count + last."""
    with _LOCK:
        d = _DISTS.get(name)
        if d is None:
            d = {"count": 0, "sum": 0.0, "last": 0.0}
            _DISTS[name] = d
        d["count"] += 1
        d["sum"] += float(value)
        d["last"] = float(value)


def counters() -> Dict[str, int]:
    """Return a shallow copy of all counters."""
    with _LOCK:
        return dict(_COUNTERS)


def snapshot() -> Dict[str, Any]:
    """Full snapshot for /api/metrics. Cheap; called on demand."""
    with _LOCK:
        dists = {
            k: {
                "count": v["count"],
                "mean": (v["sum"] / v["count"]) if v["count"] else 0.0,
                "last": v["last"],
            }
            for k, v in _DISTS.items()
        }
        return {
            "uptime_seconds": time.time() - _STARTED_AT,
            "counters": dict(_COUNTERS),
            "gauges": dict(_GAUGES),
            "distributions": dists,
        }


def reset_for_test() -> None:
    """Test-only: wipe all metric state."""
    with _LOCK:
        _COUNTERS.clear()
        _GAUGES.clear()
        _DISTS.clear()
