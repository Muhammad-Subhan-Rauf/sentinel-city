"""
LangGraph ReAct agent factory for the Sentinel-City orchestrator.

Builds two compiled StateGraphs (Detection + Monitoring) that wrap a
``ChatGoogleGenerativeAI`` model chained over the 5-model Gemini fallback
list (same as ``orchestrator.GEMINI_MODEL_FALLBACK``, preserved via
LangChain's ``.with_fallbacks()`` rather than the bespoke
``generate_with_fallback`` retry loop).

The agent itself is ``langgraph.prebuilt.create_react_agent`` — a compiled
``LLM → ToolNode → LLM → ...`` loop that terminates when the LLM emits no
more tool calls. That alone fixes bug #1: a single "Would you like me to
proceed?" turn from Gemini terminates the graph with zero tool calls
executed; the orchestrator's outer loop sees ``tool_calls_made == 0`` and
declines to advance the fingerprint, so the next tick re-prompts.

For the monitoring agent we also pass ``tool_choice="any"`` so Gemini is
forced to call SOME tool every turn. If active incidents exist, "do nothing"
is not an option — escalate, de-escalate, or at minimum re-read state.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent

logger = logging.getLogger(__name__)


# Models tried in order — identical to orchestrator.GEMINI_MODEL_FALLBACK
# so behavior under quota pressure matches what we had before.
GEMINI_MODELS: List[str] = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
]


def _build_chat_model(
    api_key: str,
    *,
    temperature: float = 0.2,
) -> Any:
    """Build a Gemini chat model with `.with_fallbacks()` over the 5-model list.

    We intentionally pass ``exceptions_to_handle=(Exception,)`` (the default)
    so any 429/5xx (and even malformed responses) cascade to the next model.
    The old ``generate_with_fallback`` gated on a specific set of HTTP codes
    via ``getattr(e, 'code', None) in _FALLBACK_STATUS_CODES``; LangChain's
    fallback chain runs *all* fallbacks for any exception, which is a slight
    behavior change — but a strictly safer one for the orchestrator since
    auth-error symptoms (which used to fail fast) will now still try every
    model. We tolerate that: an unrecoverable problem still raises at the
    end of the chain, just a few seconds later.
    """
    primary = ChatGoogleGenerativeAI(
        model=GEMINI_MODELS[0],
        temperature=temperature,
        google_api_key=api_key,
    )
    fallbacks = [
        ChatGoogleGenerativeAI(
            model=m,
            temperature=temperature,
            google_api_key=api_key,
        )
        for m in GEMINI_MODELS[1:]
    ]
    return primary.with_fallbacks(fallbacks)


def build_agent(
    api_key: str,
    system_prompt: str,
    tools: List[BaseTool],
    *,
    force_tool_use: bool = False,
    temperature: float = 0.2,
) -> Any:
    """Build a compiled ReAct agent.

    Args:
        api_key: Gemini API key.
        system_prompt: Text loaded from the matching prompts/*.md file —
            passed to ``create_react_agent`` as the system message.
        tools: List of LangChain ``BaseTool`` instances (from
            ``agent_tools.build_tools``).
        force_tool_use: If True, bind the model with ``tool_choice="any"``
            so Gemini must call some tool each turn. Use for the monitoring
            loop where "no action" is not an acceptable response when
            incidents are active.
        temperature: Sampling temperature (matches previous 0.2 default).

    Returns:
        A compiled ``StateGraph`` ready for ``await agent.ainvoke(...)``.
        The state schema is the standard ``MessagesState``; pass
        ``{"messages": [HumanMessage(...)]}`` and read the trace from
        ``result["messages"]``.
    """
    model = _build_chat_model(api_key, temperature=temperature)

    if force_tool_use:
        # bind_tools(tool_choice="any") forces Gemini into "MUST call a tool"
        # mode. If Gemini doesn't support tool_choice on this SDK version,
        # bind_tools will raise — fall back to plain create_react_agent so
        # the orchestrator still runs (the no-tool-call recovery in the
        # outer loop will catch chat-mode regressions instead).
        try:
            bound = model.bind_tools(tools, tool_choice="any")
            return create_react_agent(bound, tools=tools, prompt=system_prompt)
        except (TypeError, NotImplementedError, ValueError) as e:
            logger.warning(
                f"bind_tools(tool_choice='any') not supported on this provider: {e}. "
                "Falling back to default create_react_agent — relying on outer-loop "
                "no-tool-call recovery instead."
            )

    return create_react_agent(model, tools=tools, prompt=system_prompt)


def count_tool_calls(messages: List[Any]) -> int:
    """Count ToolMessages in an agent trace.

    Used by the orchestrator's outer loop to decide whether to advance the
    fingerprint (fix for bug #2 — text-only responses must NOT burn the
    gate).
    """
    # Imported lazily so this module is importable even when only langchain-core
    # is installed (e.g. during the requirements bump phase).
    from langchain_core.messages import ToolMessage

    return sum(1 for m in messages if isinstance(m, ToolMessage))


def extract_final_text(messages: List[Any]) -> Optional[str]:
    """Pull the final AIMessage's text content (if any) for DECISION audit."""
    from langchain_core.messages import AIMessage

    for m in reversed(messages):
        if isinstance(m, AIMessage):
            # AIMessage.content can be str OR list[dict] for multi-part responses.
            content = m.content
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict)]
                joined = " ".join(p for p in parts if p).strip()
                if joined:
                    return joined
            return None
    return None
