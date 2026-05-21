"""Cache layer that sits in front of the LLM agent invocation.

L1 = exact-match SHA256 of canonical agent input → cached message trace.
     Replays the trace (read tools re-run, mutating tools are re-issued).
L2 = (deferred) semantic similarity via local MiniLM embeddings.
"""
