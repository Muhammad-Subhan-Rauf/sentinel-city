"""Dispatch SLA + deadman heartbeat (plan §2.3a, §3.2 anti-fail-to-dispatch).

Two complementary watchdogs running as a single background task:

  1. Per-incident dispatch SLA: when `declare_incident` succeeds but no
     dispatch follows within DISPATCH_SLA_SECONDS, flag a RECOVERY_ACTION
     and force the monitoring loop to re-tick (bypass fingerprint dedup).

  2. Deadman heartbeat: if no productive agent tick has happened in
     DEADMAN_SECONDS, flag a RECOVERY_ACTION. Catches Vertex hang, infinite
     fingerprint-stuck states, and other "system silently quiet" failures.

The orchestrator imports `should_force_tick()` and consults it at the top
of each loop iteration, BEFORE the fingerprint check. The SLA tracker is
populated from `agent_tools._wrap` on every declare_incident / dispatch_*
tool success.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, Optional, Set

from metrics import inc as _metric_inc
from metrics import set_gauge as _metric_gauge

logger = logging.getLogger(__name__)


DISPATCH_SLA_SECONDS = float(os.environ.get("SENTINEL_DISPATCH_SLA", "60"))
DEADMAN_SECONDS = float(os.environ.get("SENTINEL_DEADMAN", "240"))
HEARTBEAT_POLL_SECONDS = float(os.environ.get("SENTINEL_HEARTBEAT_POLL", "10"))


# Maps incident_id → ts when declare_incident fired (cleared on first dispatch)
_DECLARED_AT: Dict[str, float] = {}
# incidents we've already flagged so we don't spam the audit log
_FLAGGED: Set[str] = set()

# Last productive (non-zero tool calls) tick timestamp per loop label
_LAST_PRODUCTIVE_TICK: Dict[str, float] = {}

# Set by the watchdog when something is wrong; orchestrator clears on read.
_FORCE_TICK = {"detection": False, "monitoring": False}


def track_declared(incident_id: str) -> None:
    """Called by agent_tools._wrap on successful declare_incident."""
    if not incident_id:
        return
    _DECLARED_AT[str(incident_id)] = time.time()
    _FLAGGED.discard(str(incident_id))
    _metric_inc("sla.declared_total")


def track_dispatched(incident_id: str) -> None:
    """Called on successful dispatch_units / multi_station_dispatch."""
    if not incident_id:
        return
    _DECLARED_AT.pop(str(incident_id), None)
    _FLAGGED.discard(str(incident_id))
    _metric_inc("sla.dispatched_total")


def track_productive_tick(label: str) -> None:
    """Called by the orchestrator after every tick where ≥1 tool fired."""
    _LAST_PRODUCTIVE_TICK[label.lower()] = time.time()


def should_force_tick(label: str) -> bool:
    """Read-and-clear the force-tick flag for this loop label."""
    key = label.lower()
    val = _FORCE_TICK.get(key, False)
    if val:
        _FORCE_TICK[key] = False
        _metric_inc(f"sla.forced_tick.{key}")
    return val


def _flag_force_tick(label: str) -> None:
    _FORCE_TICK[label.lower()] = True
    # Also wake the corresponding loop via the bus so an idle orchestrator
    # actually picks up the force-tick instead of sleeping until the next
    # external event.
    try:
        import asyncio as _asyncio
        from wake_bus import WakeBus
        bus = WakeBus.for_label(label.lower())
        loop = _asyncio.get_event_loop()
        loop.create_task(bus.push(f"sla:{label.lower()}", area=None, payload={}))
    except Exception:
        pass


async def _watchdog(audit_logger: Any) -> None:
    """Loop until cancelled. Polls SLA + deadman conditions every HEARTBEAT_POLL_SECONDS."""
    logger.info(
        f"SLA watchdog started (dispatch SLA={DISPATCH_SLA_SECONDS:.0f}s, "
        f"deadman={DEADMAN_SECONDS:.0f}s, poll={HEARTBEAT_POLL_SECONDS:.0f}s)"
    )
    while True:
        try:
            now = time.time()

            # 1. Per-incident dispatch SLA
            for incident_id, declared_ts in list(_DECLARED_AT.items()):
                age = now - declared_ts
                if age >= DISPATCH_SLA_SECONDS and incident_id not in _FLAGGED:
                    _FLAGGED.add(incident_id)
                    _metric_inc("sla.dispatch_breach")
                    logger.warning(
                        f"SLA BREACH: incident {incident_id} declared {age:.0f}s ago, "
                        "no dispatch yet — forcing monitoring tick"
                    )
                    try:
                        audit_logger.log_recovery_action(
                            agent_id="sla-watchdog",
                            error_context=f"dispatch SLA breach for incident {incident_id} (age {age:.0f}s)",
                            action_taken="force monitoring re-tick to re-evaluate dispatch decision",
                        )
                    except Exception:
                        pass
                    _flag_force_tick("monitoring")

            # 2. Deadman heartbeat
            for label, last in list(_LAST_PRODUCTIVE_TICK.items()):
                age = now - last
                _metric_gauge(f"sla.tick_age_seconds.{label}", age)
                if age >= DEADMAN_SECONDS:
                    _metric_inc(f"sla.deadman_trip.{label}")
                    logger.warning(
                        f"DEADMAN: {label} loop hasn't done a productive tick in {age:.0f}s — "
                        "forcing next tick"
                    )
                    try:
                        audit_logger.log_recovery_action(
                            agent_id="sla-watchdog",
                            error_context=f"deadman trip on {label} loop (age {age:.0f}s)",
                            action_taken="force re-tick",
                        )
                    except Exception:
                        pass
                    _flag_force_tick(label)
                    # Reset so we don't spam every poll
                    _LAST_PRODUCTIVE_TICK[label] = now
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"SLA watchdog iteration failed: {exc}", exc_info=True)

        await asyncio.sleep(HEARTBEAT_POLL_SECONDS)


def start_watchdog(audit_logger: Any) -> asyncio.Task:
    """Launch the watchdog as a background task. Returns the task handle so
    the caller (main.py:lifespan) can cancel it on shutdown."""
    return asyncio.create_task(_watchdog(audit_logger), name="sla-watchdog")
