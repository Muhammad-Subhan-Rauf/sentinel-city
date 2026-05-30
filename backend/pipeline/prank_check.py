# ─────────────────────────────────────────────────────────────────────────
# Multimodal 911-call authenticity check.
#
# When a citizen places a 911 call from inside an active disaster zone they may
# attach a photo as proof. This module asks a vision-capable Gemini model to
# weigh the call transcript + the disaster context + the attached photo and
# return a structured judgement of how genuine the call looks — so dispatch can
# prioritise real emergencies and de-prioritise likely prank / false-alarm
# traffic without ever silently dropping a call.
#
# Design mirrors pipeline.extract: lazy-built, schema-bound Vertex model, with a
# graceful-degradation contract — assess_call() NEVER raises. On any failure it
# returns a structured "uncertain" verdict so the call still reaches responders;
# the AI is an advisory signal, never a gate.
# ─────────────────────────────────────────────────────────────────────────

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field

from metrics import inc, observe

logger = logging.getLogger("sentinel.pipeline.prank_check")

# Vision model. flash (not flash-lite) by default — image reasoning is the whole
# point here, and the call volume is low (one assessment per 911 call).
_MODEL = os.environ.get("SENTINEL_PRANK_MODEL", "gemini-2.5-flash")
_TIMEOUT_S = float(os.environ.get("SENTINEL_PRANK_TIMEOUT", "12.0"))

# Cap the inbound image so a hostile / accidental huge payload can't blow up the
# request or the Vertex call. The mobile client already downscales + compresses;
# this is the server-side backstop (≈ 1.4 MB of base64 ≈ 1 MB binary).
_MAX_DATA_URL_CHARS = int(os.environ.get("SENTINEL_PRANK_MAX_IMG_CHARS", "1900000"))

_SYSTEM_PROMPT = (
    "You are the Signal Analyst for an emergency-dispatch system. A citizen has "
    "placed a 911 call from inside an area the system already believes is an "
    "active disaster zone, and may have attached a photo as proof.\n\n"
    "Judge how genuine this emergency call appears. Weigh THREE things together:\n"
    "1. The call transcript — is it coherent and consistent with the stated "
    "disaster type and severity?\n"
    "2. The disaster context the system provides.\n"
    "3. The attached photo, if any — does what you SEE corroborate the claimed "
    "emergency (e.g. visible fire/smoke for a wildfire, flooding for a flood, a "
    "crash for an accident)? A meme, screenshot, selfie, blank/black frame, "
    "stock image, or scene that plainly contradicts the claim are signals of a "
    "prank or false alarm.\n\n"
    "Be conservative: real emergencies are messy and photos are often poor. Only "
    "lean 'likely_prank' when the evidence genuinely contradicts the claim or is "
    "clearly non-serious. When unsure, say 'uncertain'. Lives depend on not "
    "dismissing real calls. If there is NO photo, judge on the transcript alone "
    "and keep confidence modest."
)


class PrankAssessment(BaseModel):
    """Structured authenticity judgement for one 911 call."""

    verdict: Literal["genuine", "uncertain", "likely_prank"] = Field(
        ..., description="Overall judgement of the call's authenticity."
    )
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="0-1 confidence in the verdict."
    )
    photo_supports_call: Optional[bool] = Field(
        None,
        description="True if the photo corroborates the claimed emergency, False "
        "if it contradicts/undermines it, null if no photo or indeterminate.",
    )
    observed: str = Field(
        "", description="One sentence: what is visible in the photo (or 'no photo')."
    )
    reasoning: str = Field(
        ..., description="One or two sentences justifying the verdict for dispatch."
    )


_MODEL_INSTANCE = None


def _build_model():
    """Build the schema-bound, vision-capable Vertex chat model. Lazy + cached."""
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is not None:
        return _MODEL_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "langchain_google_vertexai not installed; pipeline.prank_check requires Vertex AI."
        ) from exc

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT env var must be set for pipeline.prank_check")

    model = ChatVertexAI(
        model=_MODEL,
        temperature=0.0,
        project=project,
        location=location,
        max_retries=1,
    )
    _MODEL_INSTANCE = model.with_structured_output(PrankAssessment)
    return _MODEL_INSTANCE


def _uncertain(reason: str, observed: str = "no photo") -> Dict[str, Any]:
    """Fallback verdict used whenever the model can't be consulted. Advisory only —
    the call always still reaches dispatch."""
    return {
        "status": "unavailable",
        "verdict": "uncertain",
        "confidence": 0.0,
        "photo_supports_call": None,
        "observed": observed,
        "reasoning": reason,
        "model": _MODEL,
    }


def assess_call(
    transcript: str,
    disaster_type: Optional[str],
    severity: Optional[int],
    photo_data_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Synchronously assess one 911 call's authenticity. Safe to run from a
    FastAPI BackgroundTask. NEVER raises — returns a status dict ready to attach
    to the call record under ``ai_assessment``.

    Returns keys: status ('done' | 'unavailable'), verdict, confidence,
    photo_supports_call, observed, reasoning, model.
    """
    from langchain_core.messages import HumanMessage, SystemMessage

    inc("prank_check.calls_total")
    has_photo = bool(photo_data_url and photo_data_url.startswith("data:image"))
    if has_photo and len(photo_data_url) > _MAX_DATA_URL_CHARS:
        inc("prank_check.photo_too_large")
        has_photo = False  # ignore the oversized image, still judge the transcript
        photo_data_url = None

    context = (
        f"Disaster type: {disaster_type or 'unknown'}. "
        f"Reported severity: {severity if severity is not None else 'unknown'} (1-5).\n\n"
        f"Call transcript:\n\"\"\"\n{(transcript or '').strip()[:2000]}\n\"\"\"\n\n"
        + ("A photo is attached below — examine it." if has_photo else "No photo was attached.")
    )

    human_content: Any
    if has_photo:
        human_content = [
            {"type": "text", "text": context},
            {"type": "image_url", "image_url": {"url": photo_data_url}},
        ]
    else:
        human_content = context

    started = time.time()
    try:
        model = _build_model()
        msgs = [SystemMessage(content=_SYSTEM_PROMPT), HumanMessage(content=human_content)]
        result: PrankAssessment = model.invoke(msgs, config={"timeout": _TIMEOUT_S})
        observe("prank_check.latency_seconds", time.time() - started)
        inc("prank_check.success")
        inc(f"prank_check.verdict.{result.verdict}")
        if result.verdict == "likely_prank":
            inc("prank_check.pranks_flagged")
        return {
            "status": "done",
            "verdict": result.verdict,
            "confidence": round(float(result.confidence), 3),
            "photo_supports_call": result.photo_supports_call,
            "observed": result.observed,
            "reasoning": result.reasoning,
            "had_photo": has_photo,
            "model": _MODEL,
        }
    except Exception as exc:  # noqa: BLE001 - advisory path must never raise
        observe("prank_check.latency_seconds", time.time() - started)
        inc(f"prank_check.error.{type(exc).__name__}")
        inc("prank_check.error")
        logger.warning("prank_check: %s: %s", type(exc).__name__, exc)
        out = _uncertain(
            "AI authenticity check unavailable — treat as a normal call.",
            observed="photo attached" if has_photo else "no photo",
        )
        out["had_photo"] = has_photo
        return out
