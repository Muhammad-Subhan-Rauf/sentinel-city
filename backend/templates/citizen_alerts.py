"""Slot-filled message templates for high-severity citizen alerts.

Severity → template. Slots are best-effort: missing values get neutral
defaults that still produce a coherent sentence. Templates are short by
design (≤180 chars target) so they fit in a single SMS / push notification.

This module is intentionally English-only for the hackathon; the schema
reserves a `primary_language` slot so a future translator can hook in
without changing call sites.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from metrics import inc as _metric_inc


# Heuristic phrase library for inferring slots from a free-form LLM message.
_HAZARD_PATTERNS = [
    (re.compile(r"\bfire\b|\bsmoke\b|\bblaze\b|\bburning\b", re.I), "fire"),
    (re.compile(r"\bflood\b|\bwater\b|\binundat", re.I), "flooding"),
    (re.compile(r"\bgas\b|\bchemical\b|\btoxic\b|\bspill\b|\bfumes\b", re.I), "a hazardous spill"),
    (re.compile(r"\bcrash\b|\bcollision\b|\baccident\b", re.I), "an accident"),
    (re.compile(r"\bshoot|\barmed\b|\bweapon\b|\bgun\b", re.I), "an armed incident"),
    (re.compile(r"\bcollapse\b|\bstructural\b|\bbuilding\b", re.I), "a structural hazard"),
    (re.compile(r"\bexplosion\b|\bblast\b", re.I), "an explosion"),
    (re.compile(r"\bstorm\b|\bwind\b|\bhurricane\b|\btornado\b", re.I), "severe weather"),
]


def _infer_hazard(message: str) -> str:
    for pat, label in _HAZARD_PATTERNS:
        if pat.search(message):
            return label
    return "an emergency"


def _infer_area(args: Dict[str, Any]) -> str:
    ta = args.get("target_area") or {}
    if isinstance(ta, dict):
        # Radius in meters → human-readable
        r = ta.get("radius")
        try:
            r = float(r) if r is not None else None
        except (TypeError, ValueError):
            r = None
        if r:
            if r >= 1000:
                return f"within {r / 1000:.1f}km of the affected area"
            return f"within {int(r)}m of the affected area"
    return "in the affected area"


def render_warning(args: Dict[str, Any]) -> str:
    """Template for severity=warning: stay-and-shelter directive."""
    hazard = _infer_hazard(str(args.get("message") or ""))
    area = _infer_area(args)
    return (
        f"Advisory: {hazard} reported {area}. "
        f"Stay indoors, avoid the area, and follow updates from local responders."
    )[:240]


def render_evacuation(args: Dict[str, Any]) -> str:
    """Template for severity=evacuation: clear leave-now directive."""
    hazard = _infer_hazard(str(args.get("message") or ""))
    area = _infer_area(args)
    return (
        f"Evacuate now: {hazard} {area}. "
        f"Leave by the nearest safe route. Follow responders' instructions."
    )[:240]


_TEMPLATES = {
    "warning": render_warning,
    "evacuation": render_evacuation,
}


def apply_template(args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """If severity is high enough to template, return new args. Else None.

    Caller (output_linter) merges the returned args over the originals.
    """
    sev = str(args.get("severity", "")).strip().lower()
    fn = _TEMPLATES.get(sev)
    if fn is None:
        return None
    original = str(args.get("message") or "")
    new_message = fn(args)
    if new_message == original.strip():
        return None  # no change
    _metric_inc(f"template.applied.{sev}")
    return {**args, "message": new_message, "_template_original_message": original}
