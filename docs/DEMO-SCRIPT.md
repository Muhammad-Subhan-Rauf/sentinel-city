# Sentinel-City — Finals Demo Script & Prep Checklist

Companion to [`pitch.html`](pitch.html). Open the deck and press **`N`** for per-slide presenter notes (Say / Do / Prep). This file is the run-of-show plus the **must-do-before-finals** checklist, ordered by score impact.

> **Evaluation weighting** — Antigravity **25%** · Agentic Behavior **25%** · Live Functionality **20%** · Autonomous Action **15%** · Robustness/Edge **10%** · Tech Quality/UX **5%**. The deck is structured so the two 25% criteria get the most airtime.

---

## ⚠ The integrity fix that matters most

The README describes "two LangGraph ReAct agents" with `orchestrator.py` / `agent_tools.py` and a four-tool surface. **That does not exist in the code.** A judge who opens the repo will catch it and it tanks both 25% criteria. The deck has been rewritten to match what the code *actually* does, which is a **stronger** story:

**Real architecture — an event-driven pipeline, "model proposes, deterministic code disposes":**

```
citizen 911 report
  → extract        (Gemini NLU, structured output)            pipeline/extract.py      [LLM]
  → visual triage  (Gemini bind_tools → GetCCTVFeed)           pipeline/agent.py        [LLM · genuine tool-call]
  → cluster        (Python haversine, density confidence)      pipeline/cluster.py      [deterministic]
  → decide         (should_declare / cordon / alert policy)    pipeline/decide.py       [deterministic]
  → dispatch plan  (Gemini structured output + safety clamps)  pipeline/dispatch_agent.py [LLM]
  → execute        (row-locked Postgres, stamped source='ai')  pipeline/execute.py      [deterministic]
  ( 911 photo authenticity, advisory: Gemini vision )          pipeline/prank_check.py  [LLM]
```

**The 3 genuinely agentic surfaces to lead with** (all verifiable in the repo):
1. **Visual triage** — Gemini *chooses* whether to pull a CCTV frame via a real function-call (`bind_tools([GetCCTVFeed])`). Reason → tool → act → result.
2. **Dispatch planner** — Gemini sets per-station truck counts by doctrine; hard rails clamp to real capacity, drop hallucinated stations, cap the total, fail safe to `([], reason)`.
3. **Prank/authenticity check** — Gemini vision verdict on a 911 photo; **never raises**, degrades to "uncertain" so a call is never dropped.

Frame `decide.py` honestly as **deterministic safety rails** — that's the answer to "how do you stop a hallucinating model from emptying the fleet or declaring a fake disaster?"

Avoid these inaccuracies (they crept into earlier drafts): there is **no PostGIS / ST_DWithin** (it's Python haversine), and there are **no continuous "always-running" loops** (it's event-driven, triggered when a report lands).

---

## Run of show (mirrors the 7-step flow)

Assign two roles up front: **Driver** (dashboard + phone) and **Narrator** (reasoning out loud).

| Step | Slide(s) | Who | Beat |
|---|---|---|---|
| 1 · Problem | Title, Problem | Narrator | The bottleneck is human coordination. ~25s. |
| 2 · Architecture | Architecture | Narrator | Walk the rail; name LLM vs deterministic vs simulated nodes. ~40s. |
| **3 · Antigravity ★** | Antigravity ×2 | Driver | Show the real workspace: Agent Manager, a plan, a prompt→file, a debug trace. **25%.** |
| **4 · Live workflow ★** | Live workflow, Action, Mobile | Driver + Narrator | Fresh report → triage → cluster gate → declare → dispatch/cordon/alert → 3 surfaces change. |
| 5 · Agent trace | Agent trace / logs | Driver | Open AI logs drawer (`A`); expand one tool_call payload. |
| **6 · Edge case ★** | Edge cases, Real-vs-sim | Driver | Run a judge-supplied input; show graceful recovery. **10%.** |
| 7 · Value | Tech quality, Spine, Value | Narrator | Impact + scalability; disclose simulated parts; live URLs. ~30s. |

---

## Prep checklist — do these before finals (ranked by score impact)

### 🔴 P0 — capture real Google Antigravity artifacts (unlocks the 25% that is currently ~0)
There is **no captured Antigravity evidence in the repo** — only a `[ANTIGRAVITY AI TRIGGER POINT]` comment in `main.py`. Grab and pre-load on the demo machine:
- [ ] **Agent Manager** with the Sentinel-City workspace open (task / agent history visible).
- [ ] **One generated task plan / walkthrough** — note which feature it planned.
- [ ] **One prompt → generated file** pair, side by side (e.g. a FastAPI endpoint, a Pydantic schema, or a React component).
- [ ] **One real debugging trace** — name the bug it caught (e.g. malformed Gemini tool args, the hallucinated `camera_id` handling in `agent.py`).
- [ ] Confirm **live workspace access works on the demo machine**; if risky, fall back to the four screenshots (slide already has placeholder frames).
- [ ] On the "Antigravity drove the build" slide, **confirm which of the four claims are true** and demote any the team didn't actually do in Antigravity.

### 🔴 P0 — make the architecture/agentic narrative match the code
- [ ] Present the **real pipeline** (above), not "two ReAct agents." Lead the agentic slides with triage / dispatch / prank-check; call `decide.py` deterministic rails.
- [ ] Be ready to **open the files live** if a judge asks: `pipeline/agent.py` (`bind_tools`), `pipeline/dispatch_agent.py` (`_validate_and_convert` clamps), `pipeline/prank_check.py` (never raises).

### 🟠 P1 — timed live dry-run; lock the real numbers
- [ ] Run the full flow end-to-end and **measure** report→declared→dispatched wall-clock. Triage and dispatch timeouts are 60s *each* (worst case) — the typical number is fast, but **quote the measured value, not a guess.** Replace the latency tile + Step-4 footnote with it.
- [ ] Lock the **exact transcript + Manhattan address** you'll trigger, and use the same incident on the "anatomy of one decision" slide so it pre-mirrors the demo.

### 🟠 P1 — Vertex stall contingency (known stale-creds risk)
- [ ] **Verify Vertex creds** on the demo machine before judging.
- [ ] **Pre-record a clean end-to-end run** and keep it one keypress away in case the live Vertex call hangs.

### 🟠 P1 — lock 3 judge-input edge cases and rehearse each
Each should hit a different rail:
- [ ] (a) **Noisy / ambiguous** transcript → triage still extracts (text-only), density confidence holds.
- [ ] (b) **Meme / contradicting 911 photo** → `prank_check` returns `likely_prank`, call still reaches dispatch. *(Capture the admin-app screenshot.)*
- [ ] (c) **Over-dispatch request** → `dispatch_agent` capacity clamp / hallucinated-station drop.

### 🟡 P2 — capture the outcome & log screenshots (proof for the 20% + 15%)
- [ ] Before/after dashboard map — zone + cordon + trucks appearing.
- [ ] Worker-phone route bending **around** the cordon polygon.
- [ ] AI logs drawer showing one incident's `observation → decision → tool_call` chain, with an expanded `declare` / `dispatch` JSON payload.
- [ ] Admin impact tiles + one tile expanded to its AI reasoning trace.
- [ ] Photo/clip of the **3 synced surfaces** mid-run (dashboard + worker phone + citizen phone).

### 🟡 P2 — slide fill-ins
- [ ] Team name + member names (title slide).
- [ ] Live URLs printed on title + value slides (dashboard, API `/docs`, Cloud Run).
- [ ] Repo / README **QR code** on the tech-quality slide.
- [ ] (Optional) one cited real-world stat on the problem slide, or keep the qualitative framing.

---

## What's real vs simulated (say this out loud — it scores the 5% honesty criterion)

| | |
|---|---|
| **Real · live** | Gemini triage tool-call, dispatch planning, vision prank-check; clustering; declare/cordon/dispatch/alert execution; FastAPI + Postgres 16 row-locked writes stamped `source='ai'`; `/api/warnings/nearby`; dashboard + 3-role mobile; Valhalla `avoid_polygons` routing. |
| **Simulated** | Mock CCTV frames; generated weather/traffic that react to events (not live APIs); 911 dispatch against **seeded** fire/hospital/police stations (not a real CAD). |
| **Modeled** | Impact metrics — 1,284 lives · $48.32M · $12.75M are estimates for the demo scenario, not measured telemetry. |
| **Dev-time tool** | Google Antigravity planned/scaffolded/debugged the code; it is not part of the running request path. |

---

*Deck navigation: `←/→` or click to move · `N` presenter notes · `F` fullscreen. The deck shows a "⚠ PREP NEEDED" flag (in presenter mode) on any slide with open checklist items.*
