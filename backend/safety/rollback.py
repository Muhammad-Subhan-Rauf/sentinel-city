"""RollbackChecker — auto-reverts wrong actions some time after they fire.

For each high-impact tool call that succeeds, schedule a background task that
fires after `policy.rollback_delay_for(tool)` seconds. The checker re-runs
the Verifier in *audit mode* against the post-action world state. If the
verdict is now DENY and the action is reversible, the rollback tool fires
automatically — the system catches its own mistakes.

Reversibility map per tool:
  dispatch_units / multi_station_dispatch → return_units
  create_cordon → clear_cordon
  publish_citizen_alert → retract_citizen_alert
  declare_incident → clear_incident
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Dict, Optional

from metrics import inc
from safety import policy as policy_mod
from safety import verifier as verifier_mod

logger = logging.getLogger(__name__)


# Map of (offending_tool, result) → (rollback_tool, rollback_args_fn(args, result))
def _dispatch_rollback_args(args: Dict[str, Any], result: Any) -> Dict[str, Any]:
    return {
        "incident_id": args.get("incident_id"),
        "station_id": args.get("station_id"),
        "unit_type": args.get("unit_type"),
        "count": args.get("count", 1),
    }


def _multi_dispatch_rollback_args(args: Dict[str, Any], result: Any) -> Dict[str, Any]:
    # Best-effort: rollback the first dispatch only. Caller can issue further
    # corrections if needed.
    dispatches = args.get("dispatches") or []
    if not dispatches:
        return {}
    d = dispatches[0]
    return {
        "incident_id": args.get("incident_id"),
        "station_id": (d or {}).get("station_id"),
        "unit_type": (d or {}).get("unit_type"),
        "count": (d or {}).get("count", 1),
    }


def _cordon_rollback_args(args: Dict[str, Any], result: Any) -> Optional[Dict[str, Any]]:
    cordon_id = None
    if isinstance(result, dict):
        cordon_id = result.get("id") or result.get("cordon_id")
    if not cordon_id:
        return None
    return {"cordon_id": cordon_id}


def _alert_rollback_args(args: Dict[str, Any], result: Any) -> Optional[Dict[str, Any]]:
    alert_id = None
    if isinstance(result, dict):
        alert_id = result.get("id") or result.get("alert_id") or result.get("notification_id")
    if not alert_id:
        return None
    return {"alert_id": alert_id}


def _declare_rollback_args(args: Dict[str, Any], result: Any) -> Optional[Dict[str, Any]]:
    incident_id = None
    if isinstance(result, dict):
        incident_id = result.get("id") or result.get("event_id") or result.get("incident_id")
    if not incident_id:
        return None
    return {"incident_id": incident_id}


_ROLLBACK_MAP: Dict[str, tuple] = {
    "dispatch_units": ("return_units", _dispatch_rollback_args),
    "multi_station_dispatch": ("return_units", _multi_dispatch_rollback_args),
    "create_cordon": ("clear_cordon", _cordon_rollback_args),
    "publish_citizen_alert": ("retract_citizen_alert", _alert_rollback_args),
    "declare_incident": ("clear_incident", _declare_rollback_args),
}


# Track in-flight rollback tasks so they aren't GC'd before firing.
_PENDING: "set[asyncio.Task]" = set()


def schedule(
    tool: str,
    args: Dict[str, Any],
    result: Any,
    *,
    rationale: str,
    invoke_tool: Callable[[str, Dict[str, Any]], Any],
) -> None:
    """Fire-and-forget: schedule a rollback check for a recently-fired tool.

    `invoke_tool(name, args)` is a callable (awaitable) the orchestrator
    provides to actually execute a rollback tool — typically a wrapper that
    bypasses verifier/lint to avoid infinite recursion.
    """
    delay = policy_mod.rollback_delay_for(tool)
    if delay is None or tool not in _ROLLBACK_MAP:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("RollbackChecker.schedule called outside event loop; skipping")
        return
    task = loop.create_task(
        _run_check(tool, args, result, delay, rationale, invoke_tool),
        name=f"rollback:{tool}",
    )
    _PENDING.add(task)
    task.add_done_callback(_PENDING.discard)
    inc("rollback.scheduled")


async def _run_check(
    tool: str,
    args: Dict[str, Any],
    result: Any,
    delay: float,
    rationale: str,
    invoke_tool: Callable[[str, Dict[str, Any]], Any],
) -> None:
    await asyncio.sleep(delay)
    started = time.time()
    try:
        verdict = await verifier_mod.verify(
            tool=tool,
            args=args,
            rationale=f"AUDIT MODE @T+{delay:.0f}s. Original rationale: {rationale}",
            context_summary="post-action audit",
            policy_tier=3,
        )
    except Exception as exc:
        logger.warning(f"rollback verifier failed for {tool}: {exc}")
        return

    if verdict.decision != "deny":
        inc(f"rollback.audit_clean.{tool}")
        return

    inc(f"rollback.audit_deny.{tool}")
    rollback_tool, args_fn = _ROLLBACK_MAP[tool]
    rb_args = args_fn(args, result)
    if not rb_args or any(v is None for v in rb_args.values()):
        inc(f"rollback.skip_missing_id.{tool}")
        logger.info(f"rollback skipped — missing id for {tool}: {rb_args}")
        return

    logger.warning(
        f"RollbackChecker: auto-reverting {tool} via {rollback_tool}. "
        f"Verifier audit verdict: {verdict.rationale}"
    )
    try:
        await invoke_tool(rollback_tool, rb_args)
        inc(f"rollback.executed.{tool}")
    except Exception as exc:
        inc(f"rollback.failed.{tool}")
        logger.error(f"rollback execution failed for {tool} → {rollback_tool}: {exc}")
    finally:
        logger.info(f"rollback check duration: {time.time() - started:.2f}s")
