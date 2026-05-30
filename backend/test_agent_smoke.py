"""Live smoke test for the visual-triage agent.

Hits the real Vertex AI Gemini endpoint (uses .env creds) so this consumes
quota. Run with `python test_agent_smoke.py` from backend/.

What it checks:
1. Triage agent's decision quality: does it call CCTV on severe/ambiguous
   transcripts and skip on clearly-minor ones?
2. End-to-end latency: triage call + (optional) NLU call. Hackathon
   target is <5s for the severe path, <3s for the skip path.
3. The downstream NLU extraction still parses cleanly when fed multimodal
   input.
4. The no-camera fallback runs text-only NLU directly.

Output is human-readable — no assertions that hard-fail; the print summary
makes the trade-offs visible so you can decide if latency / decision
quality is good enough for the demo.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv

# Load creds from .env BEFORE importing anything that builds a Vertex model.
load_dotenv(Path(__file__).resolve().parent / ".env")

import cctv  # noqa: E402
from pipeline.agent import decide_and_extract  # noqa: E402


# ── Scenarios ────────────────────────────────────────────────────────
# Each (label, transcript, lat, lng, expect_cctv) tuple. expect_cctv is
# the *recommended* behavior — used to colour the report. Gemini gets
# graded against it but a deviation isn't a failure on its own.

CENTER_LAT, CENTER_LNG = 40.7831, -73.9712  # Upper West Side near Central Park

SCENARIOS = [
    # SEVERE — should pull CCTV
    {
        "label": "SEVERE / casualties + structural",
        "transcript": (
            "Oh my god, the whole building is on fire. People are screaming "
            "from the upper windows, I can see two people stuck on the fire "
            "escape, and part of the cornice just collapsed onto the street. "
            "There's at least three people lying on the sidewalk not moving."
        ),
        "expect_cctv": True,
    },
    {
        "label": "SEVERE / large-scale visible",
        "transcript": (
            "Huge plume of black smoke rising over the West Side — I can see "
            "it from my apartment window twenty blocks away. Sky is going dark."
        ),
        "expect_cctv": True,
    },
    # MINOR — should skip CCTV
    {
        "label": "MINOR / smoke smell",
        "transcript": (
            "I smell a little smoke in the hallway of my apartment building. "
            "No flames, no alarm going off. Just thought someone should check."
        ),
        "expect_cctv": False,
    },
    {
        "label": "MINOR / fender bender",
        "transcript": (
            "Two cars bumped at the intersection. Drivers are out exchanging "
            "info. Nobody is hurt, traffic is still flowing around them."
        ),
        "expect_cctv": False,
    },
    # AMBIGUOUS — Gemini's call
    {
        "label": "AMBIGUOUS / vague hyperbole",
        "transcript": "Huge fire downtown!!!! It's massive!!!",
        "expect_cctv": None,  # could go either way
    },
]


def _setup_cameras() -> str:
    """Spawn a single Building_Fire/sev5 zone's worth of cameras at the test
    center. The triage agent finds the nearest one by distance — three
    cameras gives find_nearest_camera something to pick from."""
    cctv.clear_all_cameras()
    cams = cctv.spawn_cameras_for_zone(
        zone_id="smoke-test-zone",
        disaster_type="Building_Fire",
        severity=5,
        centroid=(CENTER_LAT, CENTER_LNG),
        geometry_kind="area",
    )
    assert cams, "spawn_cameras_for_zone returned no cameras — folder rename may be incomplete"
    nearest = cctv.find_nearest_camera(CENTER_LAT, CENTER_LNG)
    assert nearest is not None, "find_nearest_camera returned None after spawn"
    img = cctv.resolve_image("Building_Fire", 5)
    assert img is not None and img.is_file(), f"Building_Fire/sev5 image missing: {img}"
    return nearest["id"]


async def _run_one(label: str, transcript: str, expect_cctv) -> dict:
    print(f"\n-- {label} --------------------------------------------")
    print(f"Transcript: {transcript[:160]}{'...' if len(transcript) > 160 else ''}")
    started = time.time()
    extraction, triage = await decide_and_extract(transcript, CENTER_LAT, CENTER_LNG)
    elapsed = time.time() - started

    # Triage outcome
    print(f"  triage.used_cctv = {triage.used_cctv}")
    print(f"  triage.reason    = {triage.reason}")
    if triage.used_cctv:
        print(f"  triage.camera_id = {triage.camera_id}")
        print(f"  triage.image     = {triage.cctv_image_path}")

    # Extraction
    if extraction is not None:
        print(f"  extraction.incident_type     = {extraction.incident_type}")
        print(f"  extraction.severity          = {extraction.severity}")
        print(f"  extraction.casualties        = {extraction.casualties_mentioned}")
        print(f"  extraction.location_hint     = {extraction.location_hint!r}")
        print(f"  extraction.confidence (debug)= {extraction.confidence:.2f}")
    else:
        print("  extraction = None (NLU failed)")

    # Verdict
    if expect_cctv is None:
        verdict = "OK (ambiguous — agent's call)"
    elif triage.used_cctv == expect_cctv:
        verdict = "OK"
    else:
        verdict = "UNEXPECTED — expected used_cctv=" + str(expect_cctv)
    print(f"  total elapsed    = {elapsed:.2f}s  ·  {verdict}")

    return {
        "label": label,
        "expected": expect_cctv,
        "used_cctv": triage.used_cctv,
        "verdict": verdict,
        "elapsed_s": elapsed,
        "incident_type": extraction.incident_type if extraction else None,
        "severity": extraction.severity if extraction else None,
    }


async def _run_no_camera_case() -> dict:
    """Run a transcript at coordinates with NO camera within range. The
    agent should short-circuit triage and call extract_report directly."""
    print("\n-- NO CAMERA AVAILABLE (no-triage fast path) -------------")
    far_lat, far_lng = 0.0, 0.0  # Off the African coast — no cameras here
    transcript = "Fire at the warehouse, smoke everywhere, get help now"
    started = time.time()
    extraction, triage = await decide_and_extract(transcript, far_lat, far_lng)
    elapsed = time.time() - started
    print(f"  triage.used_cctv = {triage.used_cctv} (expected False)")
    print(f"  triage.reason    = {triage.reason}")
    print(f"  extraction       = {extraction.incident_type if extraction else None} / {extraction.severity if extraction else None}")
    print(f"  total elapsed    = {elapsed:.2f}s")
    return {
        "label": "no-camera fast path",
        "used_cctv": triage.used_cctv,
        "elapsed_s": elapsed,
    }


async def main():
    cam_id = _setup_cameras()
    print(f"Cameras spawned. Nearest to test center: {cam_id}")
    print(f"GOOGLE_CLOUD_PROJECT={os.environ.get('GOOGLE_CLOUD_PROJECT')!r}")
    print(f"Triage model: {os.environ.get('SENTINEL_TRIAGE_MODEL', 'gemini-2.5-flash-lite')}")
    print(f"NLU model:    {os.environ.get('SENTINEL_EXTRACT_MODEL', 'gemini-2.5-flash-lite')}")

    results = []
    for sc in SCENARIOS:
        try:
            results.append(await _run_one(sc["label"], sc["transcript"], sc["expect_cctv"]))
        except Exception as exc:
            print(f"  CRASHED: {type(exc).__name__}: {exc}")
            results.append({"label": sc["label"], "error": str(exc), "verdict": "CRASH"})

    try:
        results.append(await _run_no_camera_case())
    except Exception as exc:
        print(f"  no-camera path CRASHED: {type(exc).__name__}: {exc}")

    # Final tally
    print("\n==========================================================")
    print("SUMMARY")
    print("==========================================================")
    for r in results:
        elapsed = r.get("elapsed_s")
        elapsed_str = f"{elapsed:.2f}s" if isinstance(elapsed, (int, float)) else "—"
        verdict = r.get("verdict", "n/a")
        cctv_flag = r.get("used_cctv")
        cctv_str = "CCTV" if cctv_flag else "skip"
        print(f"  {r['label']:42s}  {cctv_str:5s}  {elapsed_str:>7s}  {verdict}")

    cctv.clear_all_cameras()


if __name__ == "__main__":
    asyncio.run(main())
