"""Sentinel-City pipeline modules.

Single-pass NLU extraction → PostGIS clustering → deterministic Python policy
→ row-locked Supabase execution. Replaces the previous LangGraph ReAct loops
described in backend/agent_graph.py and backend/orchestrator.py.

See plan: C:/Users/Subhan/.claude/plans/the-current-ai-feels-cosmic-candle.md
"""
