"""Slot-filled citizen-alert templates (plan §3.1c).

Free-form LLM text is fine for `info` / `advisory`. For `warning` /
`evacuation`, we use a fixed template the LLM fills with structured slots
— guarantees accessibility (short sentences, action verb first, no jargon)
and prevents the LLM from emitting a panic-inducing improvisation.
"""
