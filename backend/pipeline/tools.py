"""Tool schemas exposed to the Gemini triage agent.

These are Pydantic models — LangChain's ``.bind_tools(...)`` reads the
docstring and field descriptions to build the function-calling schema
Gemini sees. The class docstring tells Gemini *when* to call the tool; the
field docs tell it *how*.

The tool here does NOT execute against any side-effecting system. It only
signals to the agent loop that Gemini wants visual evidence. The orchestrator
then resolves the image, attaches it multimodally to the final extraction
call, and audit-logs the tool invocation.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class GetCCTVFeed(BaseModel):
    """Pull a still frame from a CCTV surveillance camera near the citizen's
    reported location.

    Call this ONLY when visual evidence would change your assessment:
    - The transcript suggests potentially severe or critical conditions
      (deaths, trapped people, structural collapse, multiple injuries,
      fast-spreading fire, explosions, mass-casualty language).
    - The transcript describes a visible large-scale phenomenon (heavy
      smoke plume, flooding, building damage) where seeing it would
      meaningfully calibrate severity.
    - The transcript is genuinely ambiguous and an image would resolve it.

    Do NOT call this when:
    - The transcript clearly describes a minor incident (smoke smell, single
      small flame, fender-bender, knocked-over trash, fallen branch).
    - The transcript is too vague or off-topic to act on regardless of
      visual evidence.
    - You can already classify confidently from the text alone.

    Be conservative — every camera pull costs operator attention and
    inference latency. Only request the feed when it would genuinely change
    the dispatch decision.
    """

    camera_id: str = Field(
        ...,
        description=(
            "The camera_id to pull a feed from. Use the camera_id provided in the "
            "system context — do not invent or guess one. If no camera is listed "
            "in the context, do not call this tool."
        ),
    )
    reason: str = Field(
        ...,
        description=(
            "One concise sentence: why this transcript warrants visual "
            "confirmation. Used for the operator audit log."
        ),
    )
