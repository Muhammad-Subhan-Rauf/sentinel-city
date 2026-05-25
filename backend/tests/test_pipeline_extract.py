"""Tests for backend/pipeline/extract.py.

Covers:
  - Pydantic schema rejects malformed extractions (no fail-open path)
  - transcript_hash is stable across whitespace/case noise
  - extract_report returns None (never raises) on empty/timeout/error inputs
  - Adversarial transcripts (Pydantic stress, per plan §Verification step 4)

The LLM call itself is monkey-patched — these tests do not hit Vertex.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "postgresql://stub:stub@localhost/stub")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "stub-project")

import pipeline.extract as extract_mod
from pipeline.extract import (
    ReportExtraction,
    extract_report,
    model_version,
    transcript_hash,
)


# ── Pydantic schema validation ──────────────────────────────────────────


def test_schema_accepts_valid_extraction():
    r = ReportExtraction(
        incident_type="building_fire",
        severity="high",
        location_hint="opposite Jalal Sons",
        casualties_mentioned=True,
        confidence=0.7,
    )
    assert r.severity == "high"
    assert r.casualties_mentioned is True


def test_schema_rejects_unknown_incident_type():
    with pytest.raises(Exception):
        ReportExtraction(
            incident_type="nuclear",  # not in Literal
            severity="medium",
            location_hint="",
            casualties_mentioned=False,
            confidence=0.5,
        )


def test_schema_rejects_unknown_severity():
    with pytest.raises(Exception):
        ReportExtraction(
            incident_type="flood",
            severity="apocalyptic",
            location_hint="",
            casualties_mentioned=False,
            confidence=0.5,
        )


def test_schema_rejects_out_of_range_confidence():
    with pytest.raises(Exception):
        ReportExtraction(
            incident_type="medical",
            severity="low",
            location_hint="",
            casualties_mentioned=False,
            confidence=1.5,
        )


def test_schema_caps_location_hint_length():
    long = "x" * 500
    with pytest.raises(Exception):
        ReportExtraction(
            incident_type="other",
            severity="low",
            location_hint=long,
            casualties_mentioned=False,
            confidence=0.1,
        )


# ── transcript_hash + model_version ─────────────────────────────────────


def test_transcript_hash_is_stable_under_whitespace():
    a = transcript_hash("Fire at the market!")
    b = transcript_hash("   Fire at   the\tmarket!  ")
    assert a == b


def test_transcript_hash_is_case_insensitive():
    a = transcript_hash("FIRE AT THE MARKET")
    b = transcript_hash("fire at the market")
    assert a == b


def test_transcript_hash_differs_for_different_content():
    a = transcript_hash("fire at the market")
    b = transcript_hash("flood at the market")
    assert a != b


def test_model_version_includes_primary_model():
    assert extract_mod._PRIMARY_MODEL in model_version()


# ── extract_report() resilience ─────────────────────────────────────────


def _install_fake_model(monkeypatch, *, returns=None, raises=None, hangs=False):
    """Replace the lazy-built model with a mock so tests never hit Vertex."""
    fake = MagicMock()

    async def _ainvoke(_msgs):
        if hangs:
            await asyncio.sleep(60)
        if raises is not None:
            raise raises
        return returns

    fake.ainvoke = _ainvoke
    monkeypatch.setattr(extract_mod, "_MODEL_INSTANCE", fake)
    return fake


def test_extract_report_returns_none_on_empty_transcript():
    result = asyncio.run(extract_report(""))
    assert result is None


def test_extract_report_returns_none_on_whitespace_only():
    result = asyncio.run(extract_report("   \n\t  "))
    assert result is None


def test_extract_report_returns_extraction_on_success(monkeypatch):
    expected = ReportExtraction(
        incident_type="building_fire",
        severity="medium",
        location_hint="downtown",
        casualties_mentioned=False,
        confidence=0.8,
    )
    _install_fake_model(monkeypatch, returns=expected)
    result = asyncio.run(extract_report("There's smoke coming from a building downtown"))
    assert result is not None
    assert result.incident_type == "building_fire"
    assert result.severity == "medium"


def test_extract_report_returns_none_on_timeout(monkeypatch):
    _install_fake_model(monkeypatch, hangs=True)
    monkeypatch.setattr(extract_mod, "_TIMEOUT_S", 0.05)
    result = asyncio.run(extract_report("Fire at the market"))
    assert result is None


def test_extract_report_returns_none_on_arbitrary_exception(monkeypatch):
    _install_fake_model(monkeypatch, raises=RuntimeError("vertex 503"))
    result = asyncio.run(extract_report("Flood near the souk"))
    assert result is None


# ── Pydantic stress (plan §Verification step 4) ─────────────────────────


@pytest.mark.parametrize(
    "transcript",
    [
        "",                                       # empty
        "   ",                                    # whitespace only
        "x" * 5000,                               # 5 KB rant
        "🔥🔥🔥",                                  # emoji only
        "fire? maybe? idk lol",                   # vague
        "Help help help help help " * 50,         # repetition
        "I think there might be a thing somewhere",  # zero signal
        "<script>alert(1)</script>",              # injection-ish
        "БОЛЬШОЙ ПОЖАР",                          # cyrillic
        "نار في السوق",                            # arabic
    ],
)
def test_extract_report_never_crashes_on_adversarial_transcripts(monkeypatch, transcript):
    """The pipeline must degrade gracefully — None or a valid extraction, never an exception."""
    # Stub the model to return a valid extraction for non-empty inputs.
    if transcript and transcript.strip():
        _install_fake_model(
            monkeypatch,
            returns=ReportExtraction(
                incident_type="other",
                severity="low",
                location_hint="",
                casualties_mentioned=False,
                confidence=0.1,
            ),
        )
    result = asyncio.run(extract_report(transcript))
    assert result is None or isinstance(result, ReportExtraction)
