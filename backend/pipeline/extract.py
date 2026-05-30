"""Single-pass NLU extraction from a citizen report transcript.

The LLM's only job in the new architecture is to turn a free-text citizen
transcript into typed, schema-validated structured data. Every downstream
decision (cluster confidence, dispatch counts, station choice, cordon
radius, alert wording) is pure Python against the database.

Replaces the Detection ReAct loop. Replaces the LLM Verifier (Pydantic
enforces the schema; malformed output raises rather than silently
fail-opens).

Per the plan's Trap 1: ``confidence`` is recorded as a debug signal only.
Downstream gating uses cluster density computed server-side, never the
LLM's self-score.

Per the plan's Trap 2b: the system prompt spells out each severity enum
value with concrete examples so a single hyperbolic transcript cannot
hallucinate a ``critical``.

Memoization (the ``nlu_cache`` Postgres table) is handled by the caller
(``pipeline.execute.process_report``); this module is pure NLU.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from metrics import inc, observe

logger = logging.getLogger(__name__)


IncidentType = Literal["building_fire", "wildfire", "flood", "medical", "other"]
Severity = Literal["low", "medium", "high", "critical"]


class ReportExtraction(BaseModel):
    """The typed output of a single NLU pass.

    This is the ONLY structured data the LLM produces in the new
    architecture. Every field has a downstream consumer in pure Python:

    - ``incident_type`` → clustering key + dispatch-type routing
    - ``severity``      → policy table for unit count + cordon radius
    - ``location_hint`` → fallback geocode only if no device coords
    - ``casualties_mentioned`` → triggers server-side ambulance auto-dispatch
    - ``confidence``    → debug-only (see Trap 1); cluster density gates instead
    """

    incident_type: IncidentType = Field(
        ..., description="Closest matching incident category from the closed set."
    )
    severity: Severity = Field(
        ...,
        description=(
            "Apply STRICTLY per the rubric in the system prompt. "
            "Do not infer 'critical' from a single hyperbolic transcript."
        ),
    )
    location_hint: str = Field(
        "",
        max_length=200,
        description=(
            "Free-text place name extracted from the transcript "
            "('near the souk', 'opposite Jalal Sons'). Only consulted "
            "by Python if the report lacks device coordinates."
        ),
    )
    casualties_mentioned: bool = Field(
        False,
        description=(
            "True iff the transcript explicitly mentions injuries, death, "
            "trapped people, unconscious, bleeding, etc."
        ),
    )
    confidence: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description=(
            "Model self-rated confidence. RECORDED FOR DEBUGGING ONLY. "
            "Python downstream uses cluster-density confidence (see "
            "pipeline.cluster.cluster_confidence) to gate declare/dispatch."
        ),
    )


_SYSTEM_PROMPT = """You are the Sentinel-City NLU extractor.

Your ONE job: read a single citizen 911 / emergency-report transcript and
emit a JSON object matching the ReportExtraction schema. You do not plan
actions. You do not dispatch responders. You only classify the transcript.

────────────────────────────────────────────────────────────────────
incident_type — choose exactly one of:
  - building_fire : indoor structure fire (house, office, shop, warehouse)
  - wildfire     : outdoor vegetation fire (forest, scrub, grass, brush)
  - flood        : water inundating buildings or streets, dam/pipe burst
  - medical      : injury, cardiac, unconscious, bleeding, no fire present
  - other        : anything else (use sparingly — prefer the closest match)

If the transcript clearly describes BOTH a fire AND casualties, choose the
fire type. The casualties_mentioned flag captures the rest.

────────────────────────────────────────────────────────────────────
severity — apply STRICTLY. Do not be swayed by intensifiers ("huge", "massive",
"the worst ever") without concrete details. Hyperbole alone is not evidence.

  - low      : smoke smell, single small flame contained to one room/area,
               no spread, no injuries mentioned, no structural damage
  - medium   : visible flames, single building or contained area, no
               casualties mentioned, no rapid spread
  - high     : multi-building / fast-spreading / smoke covering a visible
               area / possible casualties / partial structural damage
  - critical : explicit casualties (deaths, trapped people, multiple
               injuries) OR structural collapse OR explosion OR explicit
               mass evacuation needed

A single transcript saying "huge fire downtown" with no further detail is
medium, NOT critical. Wait for clustered reports — the Python pipeline
upgrades severity when multiple corroborating transcripts arrive.

────────────────────────────────────────────────────────────────────
location_hint — copy the most specific place reference from the transcript
(landmark, intersection, street name, building name). Empty string if none.

────────────────────────────────────────────────────────────────────
casualties_mentioned — true ONLY if the transcript explicitly says someone
is hurt, dead, trapped, unconscious, bleeding, etc. Speculation ("could be
casualties", "might be injured") is false.

────────────────────────────────────────────────────────────────────
confidence — your self-rated belief that your extraction is correct,
0.0–1.0. This is recorded for debugging but does NOT gate any action. The
pipeline computes the real confidence from cluster density. Be honest.

Return exactly one ReportExtraction object. No prose, no explanation.
"""


# Model selection: lite primary, lite fallback. A 200-400 token classification
# does not need the 4-model survival chain we ran for the ReAct loops.
_PRIMARY_MODEL = os.environ.get("SENTINEL_EXTRACT_MODEL", "gemini-2.5-flash-lite")
_FALLBACK_MODEL = os.environ.get("SENTINEL_EXTRACT_FALLBACK", "gemini-2.0-flash-lite")
_TIMEOUT_S = float(os.environ.get("SENTINEL_EXTRACT_TIMEOUT", "60.0"))

# Lazy-built so import-time doesn't require Vertex creds. Tests can monkey-patch
# _MODEL_INSTANCE directly.
_MODEL_INSTANCE = None


def _build_model():
    """Build the schema-bound Vertex chat model. Lazy + cached for process lifetime."""
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is not None:
        return _MODEL_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
    except ImportError as exc:
        raise RuntimeError(
            "langchain_google_vertexai not installed; pipeline.extract requires Vertex AI."
        ) from exc

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT env var must be set for pipeline.extract")

    primary = ChatVertexAI(
        model=_PRIMARY_MODEL,
        temperature=0.0,
        project=project,
        location=location,
        max_retries=1,
    )
    fallback = ChatVertexAI(
        model=_FALLBACK_MODEL,
        temperature=0.0,
        project=project,
        location=location,
        max_retries=1,
    )
    chain = primary.with_fallbacks([fallback])
    _MODEL_INSTANCE = chain.with_structured_output(ReportExtraction)
    return _MODEL_INSTANCE


def transcript_hash(transcript: str) -> str:
    """Stable cache key for the ``nlu_cache`` table. Normalizes whitespace + case."""
    normalized = " ".join(transcript.strip().lower().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def model_version() -> str:
    """Cache-busting tag — invalidate nlu_cache when the model or prompt changes."""
    return f"{_PRIMARY_MODEL}|v1"


async def extract_report(
    transcript: str,
    *,
    cctv_image_path: Optional[Path] = None,
) -> Optional[ReportExtraction]:
    """Run a single-pass NLU extraction on one citizen transcript.

    If ``cctv_image_path`` is provided, the JPG/PNG bytes are inlined into the
    HumanMessage as multimodal content so Gemini can ground its classification
    in visible evidence. The image comes from a mock CCTV camera near the
    citizen's location (see backend/cctv.py); the caller is responsible for
    picking the camera and logging the implied tool call.

    Returns None on:
      - empty / whitespace-only transcript
      - LLM timeout
      - any extraction error (structured-output validation failure, network, etc.)

    Never raises. The pipeline treats None as "skip this report and audit-log
    the failure" rather than crashing the request.
    """
    from langchain_core.messages import HumanMessage, SystemMessage

    if not transcript or not transcript.strip():
        inc("extract.empty_transcript")
        return None

    inc("extract.calls_total")
    started = time.time()
    try:
        model = _build_model()
        human_content: Any = transcript.strip()[:2000]
        if cctv_image_path is not None:
            try:
                with cctv_image_path.open("rb") as fh:
                    b64 = base64.b64encode(fh.read()).decode("ascii")
                mime = "image/png" if cctv_image_path.suffix.lower() == ".png" else "image/jpeg"
                human_content = [
                    {
                        "type": "text",
                        "text": (
                            transcript.strip()[:2000]
                            + "\n\n[Attached: still frame from a nearby CCTV camera. "
                            "Use the visible evidence to ground your classification — "
                            "do not override the transcript, but corroborate severity "
                            "and incident_type against what you can see.]"
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ]
                inc("extract.with_cctv")
            except OSError as exc:
                logger.warning(
                    f"extract: failed to read CCTV image {cctv_image_path}: {exc}; falling back to text-only"
                )
                inc("extract.cctv_read_error")
        msgs = [
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(content=human_content),
        ]
        result = await asyncio.wait_for(model.ainvoke(msgs), timeout=_TIMEOUT_S)
        observe("extract.latency_seconds", time.time() - started)
        inc("extract.success")
        inc(f"extract.severity.{result.severity}")
        inc(f"extract.type.{result.incident_type}")
        return result
    except asyncio.TimeoutError:
        observe("extract.latency_seconds", time.time() - started)
        inc("extract.timeout")
        logger.warning(
            f"extract: timeout after {_TIMEOUT_S:.1f}s; transcript={transcript[:80]!r}"
        )
        return None
    except Exception as exc:
        observe("extract.latency_seconds", time.time() - started)
        inc(f"extract.error.{type(exc).__name__}")
        inc("extract.error")
        logger.warning(
            f"extract: {type(exc).__name__}: {exc}; transcript={transcript[:80]!r}"
        )
        return None
