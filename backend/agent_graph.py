"""
LangGraph ReAct agent factory for the Sentinel-City orchestrator.

Builds two compiled StateGraphs (Detection + Monitoring) that wrap a
``ChatVertexAI`` model chained over the 4-model Gemini fallback list via
LangChain's ``.with_fallbacks()``.

We use Vertex AI (not the AI Studio Gemini API) because the AI Studio
free-tier quota is 20 requests/day/model — a ReAct loop burns that in
minutes. Vertex AI bills the project's Cloud billing account directly
(uses your $300 trial credit, no separate "free tier" gating) and lifts
the per-model RPD ceiling by orders of magnitude.

Authentication is via Application Default Credentials (ADC). In the
deployed container that means a service-account JSON mounted at the path
``GOOGLE_APPLICATION_CREDENTIALS`` points to. Project + region come from
``GOOGLE_CLOUD_PROJECT`` and ``GOOGLE_CLOUD_LOCATION``.

The agent itself is ``langgraph.prebuilt.create_react_agent`` — a compiled
``LLM → ToolNode → LLM → ...`` loop that terminates when the LLM emits no
more tool calls. For the monitoring agent we also pass ``tool_choice="any"``
so Gemini is forced to call SOME tool every turn.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

from langchain_core.tools import BaseTool
from langchain_google_vertexai import ChatVertexAI
from langgraph.prebuilt import create_react_agent

logger = logging.getLogger(__name__)


# Models tried in order. Vertex's per-project quotas are far higher than
# AI Studio's free-tier RPD, so the lite-first ordering is no longer about
# survival — it's about cost. Lite is roughly 3-5x cheaper per token; we
# escalate to the full flash variants only if lite fails.
#
# ``gemini-1.5-flash`` is intentionally absent: it's retired on AI Studio
# (and pending retirement on Vertex), so including it just wastes a 404
# call at the bottom of the chain.
GEMINI_MODELS: List[str] = [
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
]


def _build_chat_model(
    project: str,
    location: str,
    *,
    temperature: float = 0.2,
) -> Any:
    """Build a Vertex AI chat model with `.with_fallbacks()` over the model list.

    Args:
        project: GCP project ID. The service account must have
            ``roles/aiplatform.user`` in this project.
        location: Vertex AI region (e.g. ``us-central1``). Not all regions
            host every Gemini model; ``us-central1`` is the safest default.
        temperature: Sampling temperature for all models in the chain.
    """
    primary = ChatVertexAI(
        model=GEMINI_MODELS[0],
        temperature=temperature,
        project=project,
        location=location,
        max_retries=1,
    )
    fallbacks = [
        ChatVertexAI(
            model=m,
            temperature=temperature,
            project=project,
            location=location,
            max_retries=1,
        )
        for m in GEMINI_MODELS[1:]
    ]
    return primary.with_fallbacks(fallbacks)


def build_agent(
    project: str,
    location: str,
    system_prompt: str,
    tools: List[BaseTool],
    *,
    force_tool_use: bool = False,
    temperature: float = 0.2,
) -> Any:
    """Build a compiled ReAct agent on top of Vertex AI Gemini.

    Args:
        project: GCP project ID.
        location: Vertex AI region.
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
        Pass ``{"messages": [HumanMessage(...)]}`` and read the trace from
        ``result["messages"]``.
    """
    model = _build_chat_model(project, location, temperature=temperature)

    if force_tool_use:
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
    fingerprint (text-only responses must NOT burn the gate).
    """
    from langchain_core.messages import ToolMessage

    return sum(1 for m in messages if isinstance(m, ToolMessage))


def extract_final_text(messages: List[Any]) -> Optional[str]:
    """Pull the final AIMessage's text content (if any) for DECISION audit."""
    from langchain_core.messages import AIMessage

    for m in reversed(messages):
        if isinstance(m, AIMessage):
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
