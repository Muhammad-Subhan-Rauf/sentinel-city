"""ActionReversibilityIndex — decides which tool calls need a Verifier pass.

Pure function of (tool_name, args) → (impact_tier, needs_verifier, needs_lint,
reversibility_seconds). No LLM, no I/O. Hot-tune the thresholds here without
touching the orchestrator.

Tier semantics:
  0  read-only or trivially reversible (no extra checks)
  1  small mutation, low blast radius (audit only; no verifier)
  2  high impact, reversible within minutes (verifier required)
  3  high impact, irreversible or city-wide (verifier + linter required)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict


@dataclass(frozen=True)
class Decision:
    tool: str
    tier: int
    needs_verifier: bool
    needs_lint: bool
    reversibility_seconds: float  # math.inf = read-only, 0 = irreversible
    reason: str


# Tuneable thresholds (the plan's "T_check_seconds" lives here too).
DISPATCH_SMALL_MAX_UNITS = 2
MULTI_STATION_BIG_THRESHOLD_UNITS = 6
CORDON_LARGE_RADIUS_M = 500  # > π·(500m)² ≈ 0.785 km²
CITIZEN_ALERT_HIGH_SEVERITIES = {"warning", "evacuation", "high", "critical"}

# Auto-rollback check delays per tool (seconds)
ROLLBACK_DELAY_SECONDS: Dict[str, float] = {
    "dispatch_units": 90.0,
    "multi_station_dispatch": 90.0,
    "create_cordon": 120.0,
    "publish_citizen_alert": 60.0,
    "declare_incident": 45.0,
}


_READ_TOOLS = {
    "get_weather", "get_traffic", "get_citizen_reports",
    "get_world_state", "get_active_notifications", "get_active_cordons",
    "triangulate_incident",
}


def _coerce_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _as_dict(d: Any) -> Dict[str, Any]:
    """Tolerate Pydantic models or plain dicts. Returns {} for unknown shapes."""
    if isinstance(d, dict):
        return d
    if hasattr(d, "model_dump"):
        try:
            return d.model_dump()
        except Exception:
            return {}
    if hasattr(d, "__dict__"):
        return dict(d.__dict__)
    return {}


def _coerce_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def evaluate(tool: str, args: Dict[str, Any]) -> Decision:
    """Map a tool call to its safety tier and required checks."""

    # Tier 0 — pure reads
    if tool in _READ_TOOLS:
        return Decision(tool, 0, False, False, math.inf, "read-only")

    # Tier 1 — trivial mutations
    if tool == "return_units":
        return Decision(tool, 1, False, False, math.inf, "recall: trivially reversible")
    if tool == "update_incident":
        # Status changes vs. note tweaks aren't worth distinguishing in the demo
        return Decision(tool, 1, False, False, math.inf, "incident notes/status")
    if tool == "retract_citizen_alert":
        return Decision(tool, 1, False, False, math.inf, "retraction of prior alert")
    if tool == "clear_cordon":
        return Decision(tool, 1, False, False, math.inf, "lift cordon")

    # Tier 2/3 — high-impact mutations
    if tool == "declare_incident":
        return Decision(tool, 2, True, False, 45.0, "creates new incident record")

    if tool == "dispatch_units":
        count = _coerce_int(args.get("count"), 1)
        if count <= DISPATCH_SMALL_MAX_UNITS:
            return Decision(tool, 2, True, False, 120.0, f"single-station dispatch ({count} units)")
        return Decision(tool, 3, True, True, 120.0, f"large single-station dispatch ({count} units)")

    if tool == "multi_station_dispatch":
        total = sum(_coerce_int(_as_dict(d).get("count"), 0) for d in (args.get("dispatches") or []))
        if total <= MULTI_STATION_BIG_THRESHOLD_UNITS:
            return Decision(tool, 2, True, False, 120.0, f"multi-station dispatch ({total} units)")
        return Decision(tool, 3, True, True, 120.0, f"large multi-station dispatch ({total} units)")

    if tool == "create_cordon":
        radius = _coerce_float(args.get("radius"), 0.0)
        if radius < CORDON_LARGE_RADIUS_M:
            return Decision(tool, 2, True, False, math.inf, f"cordon radius {radius:.0f}m")
        return Decision(tool, 3, True, True, math.inf, f"large cordon radius {radius:.0f}m")

    if tool == "publish_citizen_alert":
        sev = str(args.get("severity", "")).strip().lower()
        if sev in CITIZEN_ALERT_HIGH_SEVERITIES:
            return Decision(tool, 3, True, True, 0.0, f"high-severity citizen alert ({sev})")
        return Decision(tool, 2, True, True, 0.0, f"citizen alert ({sev})")

    if tool == "clear_incident":
        return Decision(tool, 3, True, False, 0.0, "marks incident resolved")

    # Unknown / new tools default to tier 2 with verifier — fail safe.
    return Decision(tool, 2, True, False, math.inf, f"unknown tool '{tool}' — default verify")


def rollback_delay_for(tool: str) -> float | None:
    """Seconds to wait before RollbackChecker re-evaluates. None = no rollback."""
    return ROLLBACK_DELAY_SECONDS.get(tool)
