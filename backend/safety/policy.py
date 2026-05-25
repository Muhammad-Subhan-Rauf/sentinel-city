"""Deterministic policy validators for the single-pass NLU pipeline.

This module replaces the old LLM Verifier (deleted) with pure-Python
bounds checks. Each ``validate_*`` function takes a typed action and
returns a ``ValidationResult`` — approved or denied with a structured
reason. Called by ``pipeline.execute`` BEFORE opening any DB transaction.

Hard limits enforced here, with the matching policy table:
  - dispatch.count   ≤ SEVERITY_DISPATCH_CAP[severity]  AND ≤ station_available
  - cordon.radius_m  ≤ MAX_CORDON_RADIUS_M
  - alert.message    contains a directive verb for warning/evacuation
  - declare.severity ∈ {low, medium, high, critical}
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional


# Maximum trucks per incident at any given severity. Mirrors
# pipeline.decide.FIRE_UNITS_BY_SEVERITY ceilings + a 50% headroom buffer.
SEVERITY_DISPATCH_CAP: Dict[str, int] = {
    "low": 2,
    "medium": 4,
    "high": 6,
    "critical": 8,
}

# Maximum cordon radius in meters. Larger than this is almost certainly a
# bug — Sentinel-City scenarios are city-block scale, not regional.
MAX_CORDON_RADIUS_M = 2000

# Citizen alert text caps — keep messages short and unambiguous.
MAX_ALERT_MESSAGE_LEN = 280


_DIRECTIVE_VERBS = {"evacuate", "shelter", "avoid", "stay", "leave"}
_PANIC_WORDS = {"catastrophe", "apocalypse", "doomed", "everyone is dead"}


@dataclass(frozen=True)
class ValidationResult:
    """The output of a validator. Never None; either approved or denied with reason."""
    approved: bool
    reason: str = ""

    @classmethod
    def approve(cls, reason: str = "") -> "ValidationResult":
        return cls(True, reason)

    @classmethod
    def deny(cls, reason: str) -> "ValidationResult":
        return cls(False, reason)


def validate_dispatch(
    count: int,
    severity: str,
    station_available: int,
) -> ValidationResult:
    """Bounds + capacity check for a single fire-truck dispatch order."""
    if count <= 0:
        return ValidationResult.deny(f"non-positive dispatch count {count}")
    sev = (severity or "").lower()
    cap = SEVERITY_DISPATCH_CAP.get(sev)
    if cap is None:
        return ValidationResult.deny(f"unknown severity '{severity}'")
    if count > cap:
        return ValidationResult.deny(
            f"dispatch count {count} exceeds {sev} cap of {cap}"
        )
    if station_available < count:
        return ValidationResult.deny(
            f"station has {station_available} available; requested {count}"
        )
    return ValidationResult.approve()


def validate_cordon(radius_m: int, severity: Optional[str] = None) -> ValidationResult:
    """Bounds check on a cordon order."""
    if radius_m <= 0:
        return ValidationResult.deny(f"non-positive cordon radius {radius_m}")
    if radius_m > MAX_CORDON_RADIUS_M:
        return ValidationResult.deny(
            f"cordon radius {radius_m}m exceeds max {MAX_CORDON_RADIUS_M}m"
        )
    return ValidationResult.approve()


def validate_alert(severity: str, message: str) -> ValidationResult:
    """Wording check on a citizen alert.

    Replaces the old LLM Verifier's panic-tone check + the linter's
    directive-verb check, in plain Python.
    """
    if not message or not message.strip():
        return ValidationResult.deny("empty alert message")
    if len(message) > MAX_ALERT_MESSAGE_LEN:
        return ValidationResult.deny(
            f"alert message {len(message)} chars exceeds max {MAX_ALERT_MESSAGE_LEN}"
        )
    sev = (severity or "").lower()
    if sev not in {"info", "advisory", "warning", "evacuation"}:
        return ValidationResult.deny(f"unknown alert severity '{severity}'")
    if sev in {"warning", "evacuation"}:
        if not any(v in message.lower() for v in _DIRECTIVE_VERBS):
            return ValidationResult.deny(
                f"{sev} alert missing directive verb (one of: {sorted(_DIRECTIVE_VERBS)})"
            )
    msg_lower = message.lower()
    for w in _PANIC_WORDS:
        if w in msg_lower:
            return ValidationResult.deny(f"panic-inducing language: '{w}'")
    return ValidationResult.approve()


def validate_declare(
    incident_type: str,
    severity: str,
    n_reports: int,
    derived_confidence: float,
) -> ValidationResult:
    """Sanity-check a declare_incident order before persistence.

    Last-line-of-defense check that decide.should_declare's thresholds
    weren't bypassed somehow. Mirrors the same gates but is callable
    standalone (e.g. from execute.py, from a manual operator-triggered
    declare path).
    """
    if incident_type not in {"building_fire", "wildfire", "flood", "medical", "other"}:
        return ValidationResult.deny(f"unknown incident_type '{incident_type}'")
    if severity not in SEVERITY_DISPATCH_CAP:
        return ValidationResult.deny(f"unknown severity '{severity}'")
    if n_reports < 1:
        return ValidationResult.deny(f"n_reports={n_reports} below minimum 1")
    if not (0.0 <= derived_confidence <= 1.0):
        return ValidationResult.deny(f"confidence {derived_confidence} outside [0, 1]")
    return ValidationResult.approve()
