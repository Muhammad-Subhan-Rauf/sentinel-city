# ─────────────────────────────────────────────────────────────────────────
# City-resilience insight — turns the admin heatmap aggregate into concrete,
# prioritised recommendations for making the city safer and more efficient.
#
# Design mirrors pipeline.prank_check / pipeline.extract: a lazy-built,
# schema-bound Vertex model with a graceful-degradation contract —
# generate_insight() NEVER raises. On any failure (or missing Vertex creds) it
# returns a structured "unavailable" payload so the mobile screen still shows
# the raw heatmap; the AI is advisory, never a gate.
#
# The geographic math (clusters, nearest-service distances) is done by the
# caller in main.py and passed in as `stats`. The model only writes the
# narrative + recommendations grounded in those numbers — it never does geometry.
# ─────────────────────────────────────────────────────────────────────────

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field

from metrics import inc, observe

logger = logging.getLogger("sentinel.pipeline.city_insight")

# flash (not flash-lite) by default — this is a low-volume, reasoning-heavy
# call (one per admin tap), so quality matters more than latency/cost.
_MODEL = os.environ.get("SENTINEL_CITY_INSIGHT_MODEL", "gemini-2.5-flash")
_TIMEOUT_S = float(os.environ.get("SENTINEL_CITY_INSIGHT_TIMEOUT", "20.0"))

# A single live insight call is ~20-25s of Gemini latency. The underlying stats
# only change when new disasters/casualties land, so we cache the last generated
# insight keyed by a hash of the stats: repeated taps (and concurrent clients)
# get an instant, identical result instead of re-paying the latency + token cost.
# Only successful ('done') results are cached — failures must be retryable.
_CACHE_TTL_S = float(os.environ.get("SENTINEL_CITY_INSIGHT_CACHE_TTL", "120.0"))
_INSIGHT_CACHE: Dict[str, Any] = {"key": None, "at": 0.0, "value": None}

_SYSTEM_PROMPT = (
    "You are the City Resilience Analyst for an emergency-management platform. "
    "You are given an aggregated, anonymised summary of where casualties and "
    "structural damage have historically concentrated across the city, plus the "
    "distance from each hotspot to the nearest hospital, fire station, and "
    "police station.\n\n"
    "Your job: recommend concrete, high-leverage changes that would reduce "
    "future casualties and damage AND improve operational efficiency (response "
    "time, resource placement, evacuation). Ground EVERY recommendation in the "
    "numbers provided — name the affected area and cite the cluster size or the "
    "service distance that motivates it. Prefer a few decisive actions over a "
    "long list. Be specific (e.g. 'add an ambulance post in Washington Heights "
    "— nearest hospital is 4.2 km away') rather than generic ('improve safety'). "
    "Always name the affected area using the 'area' field provided for each "
    "cluster (a human-readable neighbourhood); NEVER cite raw lat/lng "
    "coordinates in your output. Never invent data that isn't in the summary; if "
    "the data is thin, say so plainly and keep the recommendations modest."
)


class Recommendation(BaseModel):
    """One concrete, grounded city-improvement action."""

    action: str = Field(..., description="The concrete change to make, in one sentence.")
    rationale: str = Field(
        ..., description="Why — grounded in the cluster size / service distance / damage in the summary."
    )
    target_area: str = Field(
        ..., description="The area or hotspot this applies to; reference the cluster from the summary."
    )
    priority: Literal["high", "medium", "low"] = Field(
        ..., description="Urgency relative to the other recommendations."
    )


class CityInsight(BaseModel):
    """Structured resilience analysis for the admin heatmap screen."""

    title: str = Field(..., description="A short headline for the overall finding.")
    summary: str = Field(..., description="2-3 sentences on the city-wide pattern the data shows.")
    recommendations: List[Recommendation] = Field(
        default_factory=list, description="3-5 prioritised, grounded recommendations."
    )


_MODEL_INSTANCE = None


def _build_model():
    """Build the schema-bound Vertex chat model. Lazy + cached."""
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is not None:
        return _MODEL_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "langchain_google_vertexai not installed; pipeline.city_insight requires Vertex AI."
        ) from exc

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT env var must be set for pipeline.city_insight")

    model = ChatVertexAI(
        model=_MODEL,
        temperature=0.3,
        project=project,
        location=location,
        max_retries=1,
    )
    _MODEL_INSTANCE = model.with_structured_output(CityInsight)
    return _MODEL_INSTANCE


def _stats_key(stats: Dict[str, Any]) -> str | None:
    """Stable hash of the stats payload, so an unchanged heatmap reuses the cache."""
    try:
        return hashlib.sha1(
            json.dumps(stats, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
    except Exception:  # noqa: BLE001 - hashing is best-effort; cache miss is fine
        return None


def _unavailable(summary: str) -> Dict[str, Any]:
    """Fallback payload whenever the model can't be consulted. Advisory only —
    the screen still renders the raw heatmap."""
    return {
        "status": "unavailable",
        "title": "Insight unavailable",
        "summary": summary,
        "recommendations": [],
        "model": _MODEL,
    }


def generate_insight(stats: Dict[str, Any]) -> Dict[str, Any]:
    """Turn the precomputed heatmap stats into a grounded CityInsight dict.

    NEVER raises. Returns keys: status ('done' | 'empty' | 'unavailable'),
    title, summary, recommendations[] (each {action, rationale, target_area,
    priority}), model.
    """
    from langchain_core.messages import HumanMessage, SystemMessage

    inc("city_insight.calls_total")

    totals = stats.get("totals", {}) or {}
    cas_count = int(totals.get("casualty_reports", 0) or 0)
    dmg_count = int(totals.get("damage_zones", 0) or 0)
    if cas_count == 0 and dmg_count == 0:
        # Nothing to analyse — don't spend tokens.
        inc("city_insight.empty")
        return {
            "status": "empty",
            "title": "No incident history yet",
            "summary": (
                "There are no casualty reports or damage zones on record yet, so there's "
                "nothing to analyse. Once incidents accumulate, this panel will recommend "
                "where to focus city improvements."
            ),
            "recommendations": [],
            "model": _MODEL,
        }

    # Serve a recent, identical result without re-calling Gemini.
    key = _stats_key(stats)
    now = time.time()
    cached = _INSIGHT_CACHE
    if key and cached.get("key") == key and cached.get("value") and (now - cached["at"]) < _CACHE_TTL_S:
        inc("city_insight.cache_hit")
        # `cached: True` lets the caller skip re-persisting an unchanged result.
        return {**cached["value"], "cached": True}

    human = (
        "Aggregated city incident summary (JSON):\n```json\n"
        + json.dumps(stats, ensure_ascii=False, indent=2)
        + "\n```\nWrite the resilience insight and recommendations grounded in these numbers."
    )

    started = time.time()
    try:
        model = _build_model()
        msgs = [SystemMessage(content=_SYSTEM_PROMPT), HumanMessage(content=human)]
        result: CityInsight = model.invoke(msgs, config={"timeout": _TIMEOUT_S})
        observe("city_insight.latency_seconds", time.time() - started)
        inc("city_insight.success")
        payload = {
            "status": "done",
            "title": result.title,
            "summary": result.summary,
            "recommendations": [r.model_dump() for r in result.recommendations],
            "model": _MODEL,
        }
        if key:
            _INSIGHT_CACHE.update({"key": key, "at": now, "value": payload})
        # Freshly generated — caller should persist this one.
        return {**payload, "cached": False}
    except Exception as exc:  # noqa: BLE001 - advisory path must never raise
        observe("city_insight.latency_seconds", time.time() - started)
        inc(f"city_insight.error.{type(exc).__name__}")
        inc("city_insight.error")
        logger.warning("city_insight: %s: %s", type(exc).__name__, exc)
        return _unavailable(
            "Showing the raw heatmap only — the AI insight service is unreachable right now. "
            "Try again shortly."
        )
