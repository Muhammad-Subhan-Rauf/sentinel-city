"""Tests for backend/safety/policy.py validate_* functions.

These are the deterministic replacements for the deleted LLM Verifier.
Every code path that the verifier used to fail-open on (parse errors,
timeouts) is now a Python exception or a bounded check.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")

from safety.policy import (
    MAX_ALERT_MESSAGE_LEN,
    MAX_CORDON_RADIUS_M,
    SEVERITY_DISPATCH_CAP,
    ValidationResult,
    validate_alert,
    validate_cordon,
    validate_declare,
    validate_dispatch,
)


# ── ValidationResult ────────────────────────────────────────────────────


def test_approve_constructor():
    r = ValidationResult.approve("ok")
    assert r.approved is True
    assert r.reason == "ok"


def test_deny_constructor():
    r = ValidationResult.deny("nope")
    assert r.approved is False
    assert r.reason == "nope"


# ── validate_dispatch ───────────────────────────────────────────────────


def test_dispatch_valid_under_cap():
    r = validate_dispatch(count=2, severity="medium", station_available=3)
    assert r.approved


def test_dispatch_at_severity_cap_ok():
    r = validate_dispatch(count=SEVERITY_DISPATCH_CAP["high"], severity="high", station_available=10)
    assert r.approved


def test_dispatch_over_severity_cap_denied():
    r = validate_dispatch(count=SEVERITY_DISPATCH_CAP["high"] + 1, severity="high", station_available=10)
    assert not r.approved
    assert "cap" in r.reason


def test_dispatch_over_station_capacity_denied():
    r = validate_dispatch(count=3, severity="medium", station_available=1)
    assert not r.approved
    assert "available" in r.reason


def test_dispatch_zero_count_denied():
    r = validate_dispatch(count=0, severity="medium", station_available=5)
    assert not r.approved


def test_dispatch_negative_count_denied():
    r = validate_dispatch(count=-1, severity="medium", station_available=5)
    assert not r.approved


def test_dispatch_unknown_severity_denied():
    r = validate_dispatch(count=1, severity="apocalyptic", station_available=5)
    assert not r.approved


# ── validate_cordon ─────────────────────────────────────────────────────


def test_cordon_valid_radius():
    r = validate_cordon(radius_m=400)
    assert r.approved


def test_cordon_at_max_ok():
    r = validate_cordon(radius_m=MAX_CORDON_RADIUS_M)
    assert r.approved


def test_cordon_over_max_denied():
    r = validate_cordon(radius_m=MAX_CORDON_RADIUS_M + 1)
    assert not r.approved


def test_cordon_zero_denied():
    r = validate_cordon(radius_m=0)
    assert not r.approved


def test_cordon_negative_denied():
    r = validate_cordon(radius_m=-50)
    assert not r.approved


# ── validate_alert ──────────────────────────────────────────────────────


def test_alert_info_no_directive_required():
    r = validate_alert(severity="info", message="There is activity in the area.")
    assert r.approved


def test_alert_advisory_no_directive_required():
    r = validate_alert(severity="advisory", message="There is activity in the area.")
    assert r.approved


def test_alert_warning_requires_directive_verb():
    bad = validate_alert(severity="warning", message="There is activity in the area.")
    assert not bad.approved
    good = validate_alert(severity="warning", message="Avoid the area until further notice.")
    assert good.approved


def test_alert_evacuation_requires_directive_verb():
    bad = validate_alert(severity="evacuation", message="Things are bad.")
    assert not bad.approved
    good = validate_alert(severity="evacuation", message="Evacuate the building immediately.")
    assert good.approved


def test_alert_empty_message_denied():
    assert not validate_alert(severity="info", message="").approved
    assert not validate_alert(severity="info", message="   ").approved


def test_alert_oversize_message_denied():
    msg = "Avoid the area. " * 100
    assert not validate_alert(severity="warning", message=msg).approved


def test_alert_panic_language_denied():
    assert not validate_alert(severity="advisory", message="This is an apocalypse").approved


def test_alert_unknown_severity_denied():
    assert not validate_alert(severity="OMEGA", message="Avoid the area").approved


# ── validate_declare ────────────────────────────────────────────────────


def test_declare_valid():
    r = validate_declare(
        incident_type="building_fire",
        severity="high",
        n_reports=4,
        derived_confidence=0.75,
    )
    assert r.approved


def test_declare_unknown_type_denied():
    r = validate_declare(
        incident_type="nuclear",
        severity="high",
        n_reports=4,
        derived_confidence=0.75,
    )
    assert not r.approved


def test_declare_unknown_severity_denied():
    r = validate_declare(
        incident_type="building_fire",
        severity="apocalyptic",
        n_reports=4,
        derived_confidence=0.75,
    )
    assert not r.approved


def test_declare_zero_reports_denied():
    r = validate_declare(
        incident_type="flood",
        severity="medium",
        n_reports=0,
        derived_confidence=0.7,
    )
    assert not r.approved


def test_declare_confidence_out_of_range_denied():
    high = validate_declare("flood", "medium", 5, 1.5)
    assert not high.approved
    neg = validate_declare("flood", "medium", 5, -0.1)
    assert not neg.approved
