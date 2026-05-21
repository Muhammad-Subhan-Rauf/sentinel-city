"""Sentinel-City autonomous-safety layer.

All gates here are machine-side — no human in the loop. Modules:
  policy.py    – ActionReversibilityIndex: which actions warrant verification
  output_linter.py – deterministic content checks on citizen alerts + dispatch
  verifier.py  – second-opinion LLM agent for high-impact actions
  rollback.py  – auto-revert wrong actions after T+90s
"""
