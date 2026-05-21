"""Deterministic output guardrails. Pure Python, no LLM cost.

Runs immediately before a Tier-3 tool fires. Returns a `LintResult`:
  ok         – continue as-is
  modify     – execute, but with sanitized args (e.g. trimmed message)
  block      – do not execute; surface reason back to the LLM

Designed to be cheap (string ops + numeric checks) so it can run on every
high-impact action without affecting latency.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# Words that should never appear in a non-evacuation alert. Anchored to whole
# words so we don't over-trigger on incidental substrings.
_PANIC_WORDS = {
    "panic", "imminent death", "you will die", "run for your life",
    "doomed", "no hope", "armageddon", "apocalypse",
}
# Directive verbs we want present in warning/evacuation messages
_DIRECTIVE_VERBS = {
    "evacuate", "shelter", "avoid", "stay", "leave", "move",
    "follow", "exit", "remain", "go to", "head to",
}
_PANIC_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in _PANIC_WORDS) + r")\b", re.IGNORECASE)
_DIRECTIVE_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in _DIRECTIVE_VERBS) + r")\b", re.IGNORECASE)

_LOW_SEVS = {"info", "advisory", "low", "medium"}
_HIGH_SEVS = {"warning", "evacuation", "high", "critical"}


@dataclass
class LintResult:
    verdict: str  # "ok" | "modify" | "block"
    args: Dict[str, Any] = field(default_factory=dict)
    reasons: List[str] = field(default_factory=list)


def lint(tool: str, args: Dict[str, Any], world_state: Optional[Dict[str, Any]] = None) -> LintResult:
    """Dispatch to the per-tool linter; default to passthrough."""
    fn = _LINTERS.get(tool)
    if fn is None:
        return LintResult("ok", dict(args), [])
    return fn(dict(args), world_state or {})


# ── Per-tool linters ───────────────────────────────────────────────────────

def _lint_publish_citizen_alert(args: Dict[str, Any], world: Dict[str, Any]) -> LintResult:
    reasons: List[str] = []

    # Apply slot-filled template for warning/evacuation BEFORE linting so the
    # message is deterministic-shaped (panic-word filter + directive check
    # then validate the template output, catching any future template bug).
    try:
        from templates.citizen_alerts import apply_template
        templated = apply_template(args)
        if templated is not None:
            args = templated
            reasons.append(f"templated as severity={args.get('severity')}")
    except Exception:
        pass  # template is best-effort; fall through to raw-message linting

    message = str(args.get("message", "")).strip()
    severity = str(args.get("severity", "")).strip().lower()

    # 1. Empty / too short / too long
    if not message:
        return LintResult("block", args, ["alert message is empty"])
    if len(message) < 12:
        reasons.append(f"alert message too short ({len(message)} chars)")
        return LintResult("block", args, reasons)
    if len(message) > 240:
        args["message"] = message[:237].rstrip() + "..."
        reasons.append(f"alert message truncated to 240 chars (was {len(message)})")

    # 2. Panic words only allowed when severity == evacuation
    panic_hit = _PANIC_RE.search(message)
    if panic_hit and severity != "evacuation":
        reasons.append(f"panic word '{panic_hit.group(0)}' not allowed at severity={severity!r}")
        # Soften by stripping the offending word
        args["message"] = _PANIC_RE.sub("", message).strip()
        # Collapse any double spaces left over
        args["message"] = re.sub(r"\s{2,}", " ", args["message"])
        return LintResult("modify", args, reasons)

    # 3. Warning/evacuation alerts must include a directive verb
    if severity in _HIGH_SEVS and not _DIRECTIVE_RE.search(message):
        reasons.append(
            "high-severity alert missing directive verb "
            "(evacuate, shelter, avoid, stay, leave, ...)"
        )
        return LintResult("block", args, reasons)

    return LintResult("ok" if not reasons else "modify", args, reasons)


def _lint_dispatch_units(args: Dict[str, Any], world: Dict[str, Any]) -> LintResult:
    reasons: List[str] = []
    try:
        count = int(args.get("count", 0))
    except (TypeError, ValueError):
        count = 0
    # Hard cap per dispatch (per-station). Far past this is almost always wrong.
    HARD_CAP = 8
    if count > HARD_CAP:
        reasons.append(f"single-station dispatch count {count} > hard cap {HARD_CAP}; clamped")
        args["count"] = HARD_CAP
        return LintResult("modify", args, reasons)
    if count < 1:
        return LintResult("block", args, [f"dispatch count must be >= 1 (got {count})"])
    return LintResult("ok", args, [])


def _lint_multi_station_dispatch(args: Dict[str, Any], world: Dict[str, Any]) -> LintResult:
    reasons: List[str] = []
    raw = list(args.get("dispatches") or [])
    # Normalize Pydantic models → dicts so .get("count") works regardless of
    # where the args came from (LangChain materializes nested args as Pydantic).
    dispatches: List[Dict[str, Any]] = []
    for d in raw:
        if isinstance(d, dict):
            dispatches.append(d)
        elif hasattr(d, "model_dump"):
            try:
                dispatches.append(d.model_dump())
            except Exception:
                dispatches.append({})
        else:
            dispatches.append({})
    args["dispatches"] = dispatches
    if not dispatches:
        return LintResult("block", args, ["multi_station_dispatch with no dispatches"])
    total = 0
    for d in dispatches:
        try:
            total += int(d.get("count", 0))
        except (TypeError, ValueError):
            pass
    # Reserve discipline: never commit more than 75% of total available units
    # in one call. World-state knowledge is approximate; we only enforce a
    # blanket ceiling here.
    CITY_WIDE_HARD_CAP = 24
    if total > CITY_WIDE_HARD_CAP:
        reasons.append(f"multi-station dispatch total {total} > hard cap {CITY_WIDE_HARD_CAP}; clamped")
        # Proportional reduction across dispatches
        factor = CITY_WIDE_HARD_CAP / total
        new_dispatches = []
        new_total = 0
        for d in dispatches:
            d = dict(d)
            try:
                c = int(d.get("count", 0))
            except (TypeError, ValueError):
                c = 0
            d["count"] = max(1, int(c * factor))
            new_total += d["count"]
            new_dispatches.append(d)
        args["dispatches"] = new_dispatches
        return LintResult("modify", args, reasons + [f"clamped to total {new_total}"])
    return LintResult("ok", args, [])


def _lint_create_cordon(args: Dict[str, Any], world: Dict[str, Any]) -> LintResult:
    reasons: List[str] = []
    try:
        radius = float(args.get("radius", 0))
    except (TypeError, ValueError):
        radius = 0.0
    # Sane bounds
    if radius < 50:
        reasons.append(f"cordon radius {radius:.0f}m too small; raised to 100m")
        args["radius"] = 100.0
        return LintResult("modify", args, reasons)
    HARD_CAP_M = 5000.0  # 5km radius ≈ 78 km² — absurd in any normal scenario
    if radius > HARD_CAP_M:
        reasons.append(f"cordon radius {radius:.0f}m > {HARD_CAP_M:.0f}m hard cap; clamped")
        args["radius"] = HARD_CAP_M
        return LintResult("modify", args, reasons)
    return LintResult("ok", args, [])


_LINTERS = {
    "publish_citizen_alert": _lint_publish_citizen_alert,
    "dispatch_units": _lint_dispatch_units,
    "multi_station_dispatch": _lint_multi_station_dispatch,
    "create_cordon": _lint_create_cordon,
}
