"""Second-opinion Verifier agent.

A small, fast Vertex Gemini call that critiques the Proposer's proposed
high-impact tool call. Different prompt, different (cheaper) model,
temperature=0.0. Returns a structured verdict the orchestrator uses to
APPROVE / MODIFY / DENY the action.

The Verifier is intentionally lazy:
  - Only called when policy.evaluate() says needs_verifier=True
  - Doesn't get the full world state — only the action + a compact context
  - Hard input budget cap: ~600 tokens
  - Output: a single JSON object, ~100 tokens
  - Net cost: ≈ 0.1× a full Proposer call. (Plan §2.2)

Built lazily — the first verify() call constructs the ChatVertexAI instance
and caches it; subsequent calls reuse it. We never raise out of verify(): on
any error we APPROVE (fail-open) so verification cannot itself silently halt
the autonomous orchestrator. Errors are surfaced via metrics.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from metrics import inc, observe

logger = logging.getLogger(__name__)


VERIFIER_MODEL = os.environ.get("SENTINEL_VERIFIER_MODEL", "gemini-2.0-flash-lite")
VERIFIER_TIMEOUT_SECONDS = float(os.environ.get("SENTINEL_VERIFIER_TIMEOUT", "8.0"))


@dataclass
class Verdict:
    decision: str  # "approve" | "modify" | "deny"
    rationale: str
    modified_args: Optional[Dict[str, Any]] = None


_VERIFIER_PROMPT = """You are the Sentinel-City Verifier — a safety reviewer for an
autonomous emergency-response orchestrator. A Proposer agent has decided to
execute a tool. Your job is to APPROVE, MODIFY, or DENY it.

Optimize, in strict priority order:
  1. Save lives — confirmed real incidents need responders fast
  2. Prevent secondary harm (cordons trapping responders, alerts causing panic)
  3. Inform citizens clearly and calmly
  4. Conserve city resources (no over-dispatch; keep reserve capacity)

Rules:
- APPROVE if the action is correct and proportionate.
- MODIFY (provide modified_args) only if a small change makes it safe:
    - dispatch_units / multi_station_dispatch: cap excessive `count`
    - publish_citizen_alert: soften panic-inducing wording, shorten oversize
    - create_cordon: shrink an absurdly large radius
- DENY if the action would cause harm, is redundant, or has no clear basis.

Respond with EXACTLY one single-line JSON object, no code fences, no prose:
{"decision": "approve"|"modify"|"deny", "rationale": "<one short sentence>",
 "modified_args": null | {<same shape as input args>}}
"""


_MODEL_INSTANCE: Any = None


def _get_model() -> Optional[Any]:
    """Lazy-build the Vertex chat model. Returns None if unavailable."""
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is not None:
        return _MODEL_INSTANCE
    try:
        from langchain_google_vertexai import ChatVertexAI
        project = os.environ.get("GOOGLE_CLOUD_PROJECT")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        if not project:
            logger.warning("Verifier: GOOGLE_CLOUD_PROJECT not set — running in fail-open mode")
            return None
        _MODEL_INSTANCE = ChatVertexAI(
            model=VERIFIER_MODEL,
            temperature=0.0,
            project=project,
            location=location,
            max_retries=1,
        )
        return _MODEL_INSTANCE
    except Exception as exc:
        logger.warning(f"Verifier: model init failed: {exc}")
        return None


def _build_user_message(tool: str, args: Dict[str, Any], rationale: str,
                       context_summary: str, policy_tier: int) -> str:
    """Tight context: only what the Verifier needs."""
    args_blob = json.dumps(args, default=str)[:1500]
    return (
        f"Tool: {tool}\nPolicy tier: {policy_tier}\n"
        f"Args: {args_blob}\n"
        f"Proposer rationale: {rationale or '(none)'}\n"
        f"World context: {context_summary[:600] if context_summary else '(none)'}\n"
        "Verdict?"
    )


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_verdict(text: str) -> Verdict:
    """Parse the Verifier's structured response. Fail-open on parse error."""
    if not text:
        return Verdict("approve", "verifier returned empty body; fail-open")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    m = _JSON_RE.search(cleaned)
    if not m:
        return Verdict("approve", f"verifier output unparseable; fail-open: {cleaned[:120]}")
    try:
        data = json.loads(m.group(0))
    except (ValueError, json.JSONDecodeError):
        return Verdict("approve", "verifier JSON parse failed; fail-open")
    decision = str(data.get("decision", "approve")).strip().lower()
    if decision not in {"approve", "modify", "deny"}:
        decision = "approve"
    rationale = str(data.get("rationale", "") or "")[:300]
    mod = data.get("modified_args")
    if not isinstance(mod, dict):
        mod = None
    return Verdict(decision, rationale, mod)


async def verify(
    tool: str,
    args: Dict[str, Any],
    rationale: str = "",
    context_summary: str = "",
    policy_tier: int = 2,
) -> Verdict:
    """Run the second-opinion check. Always returns a Verdict (never raises)."""
    import asyncio
    started = time.time()
    inc("verifier.calls_total")
    inc(f"verifier.calls_by_tool.{tool}")

    model = _get_model()
    if model is None:
        inc("verifier.fail_open_no_model")
        return Verdict("approve", "verifier model unavailable; fail-open")

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        msgs = [
            SystemMessage(content=_VERIFIER_PROMPT),
            HumanMessage(content=_build_user_message(tool, args, rationale, context_summary, policy_tier)),
        ]
        resp = await asyncio.wait_for(model.ainvoke(msgs), timeout=VERIFIER_TIMEOUT_SECONDS)
        text = getattr(resp, "content", "") or ""
        verdict = _parse_verdict(text if isinstance(text, str) else str(text))
        inc(f"verifier.verdict.{verdict.decision}")
        observe("verifier.latency_seconds", time.time() - started)
        return verdict
    except asyncio.TimeoutError:
        inc("verifier.fail_open_timeout")
        observe("verifier.latency_seconds", time.time() - started)
        return Verdict("approve", "verifier timeout; fail-open")
    except Exception as exc:
        inc("verifier.fail_open_error")
        logger.warning(f"verifier exception: {exc}")
        return Verdict("approve", f"verifier error: {type(exc).__name__}; fail-open")
