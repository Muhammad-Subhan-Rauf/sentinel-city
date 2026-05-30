"""Triage agent — decides whether to pull a CCTV feed before NLU.

Replaces the unconditional "attach the nearest camera's image to every
extraction" shortcut. Gemini sees the transcript first and chooses, via a
proper tool-call, whether visual evidence is warranted. Only severe /
ambiguous reports trigger a CCTV pull; clear-cut minor reports go straight
to text-only extraction.

Flow:
    1. Find the nearest mock CCTV camera to the citizen's coordinates.
       If none within range, skip the triage call entirely (we have nothing
       to offer Gemini, and an unconditional triage call would just burn
       latency).
    2. Build a multimodal ChatVertexAI bound with the `GetCCTVFeed` tool
       schema. The system prompt explains the gating criteria; the human
       message contains the transcript and the available camera_id.
    3. Invoke. If the response has tool_calls, Gemini wants the feed —
       resolve the image and pass it to extract_report multimodally.
       Otherwise, call extract_report text-only.

Two LLM calls in the worst case (triage + extract); one in the common
case (triage decides no — extract runs text-only). The structured-output
contract on extract_report is untouched, which is why the loop is split
across two model invocations rather than one.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

import cctv
from metrics import inc, observe
from pipeline.extract import ReportExtraction, extract_report
from pipeline.tools import GetCCTVFeed

logger = logging.getLogger(__name__)


_TRIAGE_TIMEOUT_S = float(os.environ.get("SENTINEL_TRIAGE_TIMEOUT", "60.0"))
_TRIAGE_MODEL = os.environ.get("SENTINEL_TRIAGE_MODEL", "gemini-2.5-flash-lite")

# Lazy: tests can monkey-patch this; production builds on first use.
_TRIAGE_INSTANCE = None


def _build_triage_model():
    global _TRIAGE_INSTANCE
    if _TRIAGE_INSTANCE is not None:
        return _TRIAGE_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
    except ImportError as exc:
        raise RuntimeError(
            "langchain_google_vertexai not installed; pipeline.agent requires Vertex AI."
        ) from exc

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT env var must be set for pipeline.agent")

    base = ChatVertexAI(
        model=_TRIAGE_MODEL,
        temperature=0.0,
        project=project,
        location=location,
        max_retries=1,
    )
    _TRIAGE_INSTANCE = base.bind_tools([GetCCTVFeed])
    return _TRIAGE_INSTANCE


_TRIAGE_PROMPT = """You are the Sentinel-City visual-triage agent.

You receive ONE citizen 911 transcript at a time, before any NLU happens.
You have access to a `GetCCTVFeed` tool that returns a still frame from a
mock CCTV camera near the citizen's reported location.

Your ONLY job: decide whether this transcript warrants a CCTV pull.

GATING RULES — call the tool ONLY when at least one applies:
  - The transcript mentions deaths, trapped people, multiple casualties,
    structural collapse, explosions, or mass evacuation.
  - The transcript describes a visible large-scale phenomenon (heavy
    smoke plume, widespread flooding, major building damage) where an
    image would meaningfully change severity.
  - The transcript is genuinely ambiguous about severity and the image
    would resolve it.

DO NOT call the tool for:
  - Minor incidents (smoke smell, single small flame, fender-bender,
    knocked-over trash, fallen branch, broken window, road obstruction
    that's clearly small).
  - Vague or off-topic transcripts where no image will help.
  - Transcripts you can already classify confidently from text alone.

A camera_id is supplied to you in the human message. If you call the tool,
use that exact camera_id — do not invent one. If no camera_id is supplied,
do not call the tool.

If you decide NOT to call the tool, respond with one short sentence
explaining why (this goes into the operator audit log). Do NOT produce a
classification — a separate extractor handles that.
"""


@dataclass
class TriageOutcome:
    used_cctv: bool
    camera_id: Optional[str]
    cctv_image_path: Optional[Any]  # pathlib.Path | None — kept loose to avoid the import here
    reason: str  # Gemini's rationale; goes into the audit log
    nearest_camera: Optional[Dict[str, Any]]


async def decide_and_extract(
    transcript: str,
    lat: float,
    lng: float,
) -> Tuple[Optional[ReportExtraction], TriageOutcome]:
    """End-to-end: run the visual triage agent, then the NLU extractor.

    Returns (extraction, outcome). Either may be None / empty for caller
    handling. The triage step is skipped (and `outcome.used_cctv=False`)
    when no camera sits within the lookup radius — there's nothing for
    Gemini to choose between.
    """
    nearest = cctv.find_nearest_camera(lat, lng)
    if nearest is None:
        inc("agent.triage.no_camera_available")
        extraction = await extract_report(transcript)
        return extraction, TriageOutcome(
            used_cctv=False,
            camera_id=None,
            cctv_image_path=None,
            reason="no nearby CCTV camera",
            nearest_camera=None,
        )

    triage = await _triage(transcript, nearest)

    if not triage.used_cctv:
        extraction = await extract_report(transcript)
        return extraction, triage

    # Gemini wanted the feed. Resolve the image and pass it through.
    image_path = cctv.resolve_image(nearest["disaster_type"], nearest["severity"])
    triage.cctv_image_path = image_path
    if image_path is None:
        # Tool was requested but no asset exists — fall through to text-only
        # extraction so we don't crash on a missing file. The audit log
        # records that the feed was unavailable.
        triage.reason = f"{triage.reason} [feed unavailable for {nearest['disaster_type']}/sev{nearest['severity']}]"
        extraction = await extract_report(transcript)
        return extraction, triage

    extraction = await extract_report(transcript, cctv_image_path=image_path)
    return extraction, triage


async def _triage(
    transcript: str, nearest_camera: Dict[str, Any]
) -> TriageOutcome:
    """One Gemini call with bind_tools. Returns whether the feed was requested
    and the rationale. Never raises — falls back to ``used_cctv=False`` on
    any error so the pipeline still runs."""
    from langchain_core.messages import HumanMessage, SystemMessage

    inc("agent.triage.calls_total")
    started = time.time()
    try:
        model = _build_triage_model()
        human = (
            f"Citizen 911 transcript:\n\"{transcript.strip()[:1500]}\"\n\n"
            f"Available CCTV camera (use this exact camera_id if you call the tool):\n"
            f"  camera_id = {nearest_camera['id']}\n"
            f"  location  = ({nearest_camera['lat']:.5f}, {nearest_camera['lng']:.5f})\n\n"
            f"Decide: call GetCCTVFeed if visual evidence would change the assessment, "
            f"otherwise respond with a brief explanation."
        )
        msgs = [SystemMessage(content=_TRIAGE_PROMPT), HumanMessage(content=human)]
        result = await asyncio.wait_for(model.ainvoke(msgs), timeout=_TRIAGE_TIMEOUT_S)
        observe("agent.triage.latency_seconds", time.time() - started)

        tool_calls = getattr(result, "tool_calls", None) or []
        if tool_calls:
            tc = tool_calls[0]
            args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
            requested_id = args.get("camera_id")
            reason = args.get("reason") or "Gemini requested visual confirmation."

            # Defense against hallucinated camera_ids: if Gemini invented one,
            # quietly substitute the camera we actually offered. We already
            # validated existence by handing it in the prompt.
            if requested_id != nearest_camera["id"]:
                logger.info(
                    f"triage: Gemini requested camera_id={requested_id!r}; "
                    f"substituting offered {nearest_camera['id']!r}"
                )
            inc("agent.triage.called_cctv")
            return TriageOutcome(
                used_cctv=True,
                camera_id=nearest_camera["id"],
                cctv_image_path=None,  # filled in by caller after resolve
                reason=reason,
                nearest_camera=nearest_camera,
            )

        text = (result.content or "").strip() if hasattr(result, "content") else ""
        inc("agent.triage.skipped_cctv")
        return TriageOutcome(
            used_cctv=False,
            camera_id=None,
            cctv_image_path=None,
            reason=text or "Gemini judged the transcript clear enough without CCTV.",
            nearest_camera=nearest_camera,
        )
    except asyncio.TimeoutError:
        observe("agent.triage.latency_seconds", time.time() - started)
        inc("agent.triage.timeout")
        logger.warning(f"triage: timeout after {_TRIAGE_TIMEOUT_S:.1f}s; defaulting to text-only NLU")
        return TriageOutcome(
            used_cctv=False,
            camera_id=None,
            cctv_image_path=None,
            reason="triage timed out; defaulting to text-only NLU",
            nearest_camera=nearest_camera,
        )
    except Exception as exc:
        observe("agent.triage.latency_seconds", time.time() - started)
        inc(f"agent.triage.error.{type(exc).__name__}")
        logger.warning(f"triage: {type(exc).__name__}: {exc}; defaulting to text-only NLU")
        return TriageOutcome(
            used_cctv=False,
            camera_id=None,
            cctv_image_path=None,
            reason=f"triage error ({type(exc).__name__}); defaulting to text-only NLU",
            nearest_camera=nearest_camera,
        )
