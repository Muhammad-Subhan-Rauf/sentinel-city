"""End-to-end pipeline test.

Drives the real FastAPI app against the real Postgres + real Vertex AI:
  1. Place a fire station.
  2. For each fire-dispatch-relevant disaster type (Building_Fire, Flood,
     Wildfire), trigger an operator zone at a known centroid.
  3. Fire 2+ severe citizen reports clustered near that centroid (enough
     to clear MIN_REPORTS_TO_DECLARE = 2).
  4. Verify the AI:
     - Declared an incident (audit TOOL_CALL declare_incident).
     - Issued at least one dispatch (audit TOOL_CALL dispatch_units +
       active_dispatches row in Postgres).
     - Triangulated the centroid within ACCURACY_THRESHOLD_M of the truth.

FastAPI's TestClient awaits async BackgroundTasks before .post() returns,
so the pipeline has fully run by the time we check. No polling.

Run with `python test_pipeline_e2e.py` from backend/. Burns a few cents
of Vertex quota per disaster type (~3-6 LLM calls per type).
"""
from __future__ import annotations

import math
import os
import time
import uuid
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

# Load .env BEFORE importing the app (DATABASE_URL + Vertex creds).
load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402  - imports the FastAPI app
import cctv  # noqa: E402
from audit import GLOBAL_LOG_BUFFER  # noqa: E402


# Where dispatches need to converge. Manhattan, between UWS and Midtown.
TEST_LAT = 40.7820
TEST_LNG = -73.9710

# Fire station is placed a few blocks east so dispatches have somewhere
# to drive from but the AI's centroid still has to settle near the actual
# reports.
STATION_LAT = 40.7810
STATION_LNG = -73.9650

ACCURACY_THRESHOLD_M = 600.0  # AI triangulation must come within this distance

# Each scenario: operator type → NLU type the AI should classify as.
SCENARIOS = [
    {
        "label": "Building_Fire @ sev5",
        "operator_type": "Building_Fire",
        "operator_severity": 5,
        "expected_nlu_type": "building_fire",
        "transcript": (
            "There's a massive fire in the building right in front of me. "
            "I can see flames coming out of three different windows on the "
            "upper floors. People are screaming and waving from the fire "
            "escape. The whole place looks like it's about to go up."
        ),
    },
    {
        "label": "Flood @ sev5",
        "operator_type": "Flood",
        "operator_severity": 5,
        "expected_nlu_type": "flood",
        "transcript": (
            "The street is completely flooded, water is up to the car "
            "windows. Several vehicles are stranded with people stuck "
            "inside. The water is still rising fast and it's already "
            "going into the ground-floor shops."
        ),
    },
    {
        "label": "Wildfire @ sev5",
        "operator_type": "Wildfire",
        "operator_severity": 5,
        "expected_nlu_type": "wildfire",
        "transcript": (
            "Huge wildfire spreading through the park, the trees are fully "
            "engulfed and the flames are jumping toward the buildings on "
            "the edge. Heavy black smoke is everywhere and embers are "
            "raining down on the street."
        ),
    },
]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def reset_state(client: TestClient, conn) -> None:
    """Wipe all disasters + their dispatches/cordons/reports. Clears CCTV
    cameras as a side-effect (the API endpoint does it)."""
    client.delete("/api/disasters")
    with conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM active_dispatches;")
            cur.execute("DELETE FROM citizen_reports;")
            cur.execute("DELETE FROM cordons;")
    GLOBAL_LOG_BUFFER.clear()


def ensure_fire_station(client: TestClient) -> str:
    """Place exactly one fire station near the test centroid. Returns id."""
    res = client.get("/api/fire-stations")
    res.raise_for_status()
    stations = res.json().get("stations", [])
    for s in stations:
        # Remove any leftover stations to keep dispatch resolution deterministic.
        client.delete(f"/api/fire-stations/{s['id']}")
    res = client.post(
        "/api/fire-stations",
        json={
            "name": "E2E Test Station",
            "lat": STATION_LAT,
            "lng": STATION_LNG,
            "truck_count": 6,
        },
    )
    res.raise_for_status()
    res = client.get("/api/fire-stations")
    return res.json()["stations"][0]["id"]


def trigger_operator_disaster(
    client: TestClient, disaster_type: str, severity: int
) -> str:
    payload = {
        "id": str(uuid.uuid4()),
        "disaster_type": disaster_type,
        "severity": severity,
        "geometry": {"type": "Point", "coordinates": [TEST_LNG, TEST_LAT]},
        "geometry_kind": "point",
        "status": "active",
        "source": "operator",
    }
    res = client.post("/api/trigger-disaster", json=payload)
    res.raise_for_status()
    return res.json()["event_id"]


def fire_citizen_reports(client: TestClient, event_id: str, transcript: str, n: int = 3):
    """Post N reports near the test centroid for the given operator event_id.
    Coordinates are jittered ~40m apart so they all fall inside the 300m
    cluster window. Same transcript → 2nd+ reports hit the NLU cache."""
    offsets = [
        (0.0001, 0.0001),
        (-0.0001, 0.0002),
        (0.0002, -0.0001),
        (-0.0002, -0.0002),
        (0.0, 0.0003),
    ]
    reports = []
    for i in range(n):
        dlat, dlng = offsets[i % len(offsets)]
        reports.append({
            "event_id": event_id,
            "citizen_idx": 9000 + i,
            "report_kind": "observation",
            "location": {"lat": TEST_LAT + dlat, "lng": TEST_LNG + dlng},
            "transcript": transcript,
            "perceived_severity": 5,
        })
    res = client.post("/api/citizen-report", json={"reports": reports})
    res.raise_for_status()
    return res.json()


def audit_events(event_type: str, tool_name: str = None):
    out = []
    for e in list(GLOBAL_LOG_BUFFER):
        if e.get("event_type") != event_type:
            continue
        details = e.get("details", {})
        if tool_name and details.get("tool_name") != tool_name:
            continue
        out.append(details)
    return out


def query_ai_disaster_for_type(conn, nlu_type: str) -> dict | None:
    """Find the AI-declared disaster row for this incident type."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, disaster_type, severity, location_estimate, source, created_at
            FROM disaster_events
            WHERE disaster_type = %s
            ORDER BY created_at DESC
            LIMIT 1;
            """,
            (nlu_type,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "disaster_type": row[1],
        "severity": row[2],
        "location_estimate": row[3],
        "source": row[4],
        "created_at": row[5],
    }


def query_ai_dispatches(conn, incident_id: str) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, service_type, unit_count, target_lat, target_lng, source
            FROM active_dispatches
            WHERE event_id = %s;
            """,
            (incident_id,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": str(r[0]),
            "service_type": r[1],
            "unit_count": r[2],
            "target_lat": r[3],
            "target_lng": r[4],
            "source": r[5],
        }
        for r in rows
    ]


def run_scenario(client: TestClient, conn, sc: dict) -> dict:
    print(f"\n-- {sc['label']} ------------------------------------------------")
    reset_state(client, conn)
    station_id = ensure_fire_station(client)

    op_event_id = trigger_operator_disaster(
        client, sc["operator_type"], sc["operator_severity"]
    )
    print(f"  operator event_id = {op_event_id}")

    # Verify cameras spawned (sanity)
    cam_res = client.get(f"/api/cctv/cameras?zone_id={op_event_id}")
    cams = cam_res.json().get("cameras", [])
    print(f"  CCTV cameras spawned: {len(cams)}")

    # Fire reports. TestClient runs BackgroundTasks synchronously after
    # the response — pipeline has fully run by the time .post() returns.
    started = time.time()
    submission = fire_citizen_reports(client, op_event_id, sc["transcript"], n=3)
    elapsed = time.time() - started
    print(f"  3 reports submitted + pipeline finished in {elapsed:.2f}s")
    print(f"  /api/citizen-report response: {submission}")

    # 1. Did the AI declare an incident of the expected NLU type?
    declares = [
        d for d in audit_events("TOOL_CALL", tool_name="declare_incident")
        if d.get("arguments", {}).get("incident_type") == sc["expected_nlu_type"]
    ]
    print(f"  audit TOOL_CALL declare_incident ({sc['expected_nlu_type']}): {len(declares)}")
    if not declares:
        # Fall back to checking what types DID get declared
        all_declares = audit_events("TOOL_CALL", tool_name="declare_incident")
        print(f"    NB: any-type declares in this window: "
              f"{[d.get('arguments', {}).get('incident_type') for d in all_declares]}")

    # 2. Find the AI-declared row in the DB
    ai_row = query_ai_disaster_for_type(conn, sc["expected_nlu_type"])
    if ai_row is None:
        print(f"  PIPELINE: no AI-declared {sc['expected_nlu_type']} row in DB")
        return {"label": sc["label"], "declared": False, "dispatched": False, "distance_m": None}
    print(f"  AI declared row id={ai_row['id']}  severity={ai_row['severity']}  source={ai_row['source']}")

    # 3. Triangulation accuracy
    loc = ai_row["location_estimate"] or {}
    ai_lat = loc.get("lat")
    ai_lng = loc.get("lng")
    if ai_lat is None or ai_lng is None:
        distance = None
        print("  AI location_estimate missing — can't measure triangulation accuracy")
    else:
        distance = haversine_m(TEST_LAT, TEST_LNG, ai_lat, ai_lng)
        print(f"  AI centroid ({ai_lat:.5f}, {ai_lng:.5f})  vs  truth ({TEST_LAT}, {TEST_LNG})")
        print(f"  triangulation error: {distance:.0f}m  (threshold {ACCURACY_THRESHOLD_M:.0f}m)")

    # 4. Did the AI dispatch units?
    dispatch_tool_calls = audit_events("TOOL_CALL", tool_name="dispatch_units")
    relevant_dispatch_tool_calls = [
        d for d in dispatch_tool_calls
        if d.get("arguments", {}).get("incident_id") == ai_row["id"]
    ]
    db_dispatches = query_ai_dispatches(conn, ai_row["id"])
    total_units = sum(d["unit_count"] for d in db_dispatches)
    print(f"  audit TOOL_CALL dispatch_units rows for this incident: {len(relevant_dispatch_tool_calls)}")
    print(f"  DB active_dispatches rows for this incident: {len(db_dispatches)} ({total_units} total units)")

    # Surface the AI dispatch agent's rationale (stored in the "Plan response"
    # DECISION audit event for this incident) so a 0-dispatch outcome can be
    # debugged.
    plan_decisions = [
        d for d in audit_events("DECISION")
        if ai_row["id"] in (d.get("context") or "")
    ]
    for pd in plan_decisions[-1:]:
        print(f"  plan rationale: {pd.get('rationale')}")
    if db_dispatches:
        for d in db_dispatches:
            d_distance = haversine_m(TEST_LAT, TEST_LNG, d["target_lat"], d["target_lng"])
            print(f"    -> {d['unit_count']}× {d['service_type']} aimed at ({d['target_lat']:.5f}, {d['target_lng']:.5f}) - {d_distance:.0f}m off truth")

    return {
        "label": sc["label"],
        "declared": True,
        "dispatched": len(db_dispatches) > 0,
        "units": total_units,
        "distance_m": distance,
        "accurate": (distance is not None and distance <= ACCURACY_THRESHOLD_M),
        "elapsed_s": elapsed,
    }


def main_entry():
    results = []
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with TestClient(main.app) as client:
            print(f"GOOGLE_CLOUD_PROJECT = {os.environ.get('GOOGLE_CLOUD_PROJECT')!r}")
            print(f"Test centroid = ({TEST_LAT}, {TEST_LNG})")
            print(f"Triangulation threshold = {ACCURACY_THRESHOLD_M:.0f}m")
            for sc in SCENARIOS:
                try:
                    results.append(run_scenario(client, conn, sc))
                except Exception as exc:
                    print(f"  CRASHED: {type(exc).__name__}: {exc}")
                    import traceback
                    traceback.print_exc()
                    results.append({"label": sc["label"], "error": str(exc)})
            # Clean up so the test doesn't leave fixtures behind.
            reset_state(client, conn)
    finally:
        conn.close()

    print("\n==========================================================")
    print("E2E SUMMARY")
    print("==========================================================")
    print(f"{'Scenario':30s}  {'Decl':>5s}  {'Disp':>5s}  {'Units':>6s}  {'Tri-err':>8s}  {'OK?':>4s}  {'Elapsed':>8s}")
    overall_ok = True
    for r in results:
        if "error" in r:
            print(f"  {r['label']:30s}  CRASH: {r['error']}")
            overall_ok = False
            continue
        decl = "y" if r.get("declared") else "n"
        disp = "y" if r.get("dispatched") else "n"
        units = r.get("units", 0)
        dist = r.get("distance_m")
        dist_str = f"{dist:.0f}m" if dist is not None else "n/a"
        ok = r.get("declared") and r.get("dispatched") and r.get("accurate")
        if not ok:
            overall_ok = False
        elapsed = r.get("elapsed_s", 0)
        print(f"  {r['label']:30s}  {decl:>5s}  {disp:>5s}  {units:>6d}  {dist_str:>8s}  {'OK' if ok else 'FAIL':>4s}  {elapsed:>6.1f}s")
    print()
    print(f"OVERALL: {'ALL PASS' if overall_ok else 'AT LEAST ONE FAILURE'}")


if __name__ == "__main__":
    main_entry()
