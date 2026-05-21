"""L1 exact-match agent cache (plan §1.1a).

When the orchestrator builds the same world-state input it built before AND
the previous run produced ≥1 tool calls, we replay the cached tool-call
*plan* instead of paying for another Gemini invocation.

What gets replayed: the *tool intent* (name + args). The actual tool fires
fresh — read tools re-fetch live data (cheap, already TTL-cached), mutating
tools re-issue the action through the same safety layer (policy + lint +
verifier + rollback). So a cache hit:
  - Saves the LLM call entirely
  - Does not commit stale dispatches without re-running the verifier
  - Returns a result trace shaped like the original (so downstream code
    that calls count_tool_calls / extract_final_text still works)

TTL is short (5 min) because world-state inputs change fast; long enough
to coalesce bursts during a single demo scenario.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from metrics import inc as _metric_inc

logger = logging.getLogger(__name__)

# Cache entries time out aggressively — world state changes fast in demos.
DEFAULT_TTL_SECONDS = float(300.0)


def _canonical_key(label: str, context: Dict[str, Any]) -> str:
    """Stable hash of the agent input. Keys ordered, defaults best-effort.

    `label` distinguishes the two loops (Detection vs Monitoring) so a
    detection-tick fingerprint never collides with a monitoring tick.
    """
    try:
        blob = json.dumps(context, sort_keys=True, default=str)
    except (TypeError, ValueError):
        blob = repr(context)
    return f"{label}:{hashlib.sha256(blob.encode('utf-8')).hexdigest()}"


# (expiry_ts, planned_tool_calls) where planned_tool_calls is a list of
# (tool_name, args_dict) tuples extracted from the prior agent trace.
_CACHE: Dict[str, Tuple[float, List[Tuple[str, Dict[str, Any]]]]] = {}


def _extract_tool_calls(messages: List[Any]) -> List[Tuple[str, Dict[str, Any]]]:
    """Pull (name, args) tuples out of a LangGraph message trace.

    Pure: only reads; safe to call repeatedly.
    """
    out: List[Tuple[str, Dict[str, Any]]] = []
    for m in messages or []:
        tool_calls = getattr(m, "tool_calls", None)
        if not tool_calls:
            continue
        for tc in tool_calls:
            if isinstance(tc, dict):
                name = tc.get("name") or tc.get("function", {}).get("name")
                args = tc.get("args") or tc.get("arguments") or {}
            else:
                name = getattr(tc, "name", None)
                args = getattr(tc, "args", None) or getattr(tc, "arguments", {}) or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, json.JSONDecodeError):
                    args = {"_raw": args}
            if name and isinstance(args, dict):
                out.append((str(name), args))
    return out


def lookup(label: str, context: Dict[str, Any]) -> Optional[List[Tuple[str, Dict[str, Any]]]]:
    """Return the cached tool-call plan for this input, or None on miss."""
    key = _canonical_key(label, context)
    entry = _CACHE.get(key)
    if not entry:
        _metric_inc(f"agent_cache.{label.lower()}.miss")
        return None
    expiry, plan = entry
    if expiry < time.time():
        _CACHE.pop(key, None)
        _metric_inc(f"agent_cache.{label.lower()}.expired")
        return None
    _metric_inc(f"agent_cache.{label.lower()}.hit")
    _metric_inc("agent_cache.hit_total")
    return plan


def store(label: str, context: Dict[str, Any], messages: List[Any], ttl: float = DEFAULT_TTL_SECONDS) -> None:
    """Cache the tool-call plan extracted from a successful agent run."""
    plan = _extract_tool_calls(messages)
    if not plan:
        return  # nothing to replay
    key = _canonical_key(label, context)
    _CACHE[key] = (time.time() + ttl, plan)
    _metric_inc("agent_cache.store_total")


async def replay(
    plan: List[Tuple[str, Dict[str, Any]]],
    invoke_tool: Callable[[str, Dict[str, Any]], Awaitable[Any]],
    label: str,
) -> Dict[str, Any]:
    """Re-execute a cached tool-call plan via the live tool layer.

    Returns a dict shaped like the LangGraph result (`{"messages": [...]}`)
    so the orchestrator's existing count_tool_calls + extract_final_text
    work without changes. Each replayed call carries fake AIMessage +
    ToolMessage wrappers so the trace looks coherent in logs.
    """
    try:
        from langchain_core.messages import AIMessage, ToolMessage
    except ImportError:
        # Hot path for tests / environments without langchain
        class AIMessage:  # type: ignore[no-redef]
            def __init__(self, content="", tool_calls=None):
                self.content = content
                self.tool_calls = tool_calls or []

        class ToolMessage:  # type: ignore[no-redef]
            def __init__(self, content="", tool_call_id=""):
                self.content = content
                self.tool_call_id = tool_call_id

    messages: List[Any] = []
    for i, (tool_name, args) in enumerate(plan):
        call_id = f"cache_replay_{label}_{i}"
        messages.append(AIMessage(
            content="",
            tool_calls=[{"id": call_id, "name": tool_name, "args": args}],
        ))
        try:
            result = await invoke_tool(tool_name, args)
            content = json.dumps(result, default=str)[:2000]
        except Exception as exc:
            _metric_inc(f"agent_cache.replay_error.{tool_name}")
            content = f"ERROR: {type(exc).__name__}: {exc}"
        messages.append(ToolMessage(content=content, tool_call_id=call_id))
    _metric_inc(f"agent_cache.replay.{label.lower()}")
    _metric_inc("agent_cache.replays_total")
    return {"messages": messages}


def clear_for_test() -> None:
    _CACHE.clear()
