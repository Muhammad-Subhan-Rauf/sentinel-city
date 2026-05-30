"""Pipeline stress test — 8 disasters fired simultaneously.

Triggers 8 operator-placed disasters across Manhattan, then fires their
citizen reports CONCURRENTLY using a thread pool. The AI pipeline must:

    1. Declare each incident with the right NLU type.
    2. Triangulate each centroid near the actual reports.
    3. Dispatch fire trucks proportional to the incident profile.
    4. Do all of this fast enough that trucks arrive on-scene before the
       disaster reaches its modelled "max size" (T_max) — beyond which we
       count the disaster as un-combatted and estimate civilian impact.

Concurrency: each disaster's report-batch runs on its own thread. They
all hit /api/citizen-report at the same time; the FastAPI BackgroundTask
queues spin up 8 pipeline runs in parallel. The AI dispatch agent + NLU
extractor handle 8 simultaneous Vertex calls.

Combat-time proxy (no frontend simulator running):
    time_to_scene = pipeline_latency + nearest_station_distance / 13.4 m/s
                                       ^^^ ~30 mph city traffic
    T_max[type]   — seconds before disaster reaches "catastrophic" size.
    success       = time_to_scene < T_max
    casualties    = max_casualties[severity] * min(1.0, time_to_scene / T_max)

If T_max is missed we score the disaster as a partial loss: civilian
impact scales linearly with how late we are.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import cctv  # noqa: E402
from audit import GLOBAL_LOG_BUFFER  # noqa: E402


# ── Combat-time model ──────────────────────────────────────────────────

# Per-type "time until catastrophic" — seconds from incident declare to
# the point where civilian impact saturates. Calibrated against real
# operational standards:
#
#   - building_fire: NFPA 1710 sets the first-engine response target at
#     240 s (4 min). Earlier than that, occupants are usually rescuable;
#     past it, flashover + propagation make recovery much harder.
#   - wildfire:      300 s before the front meaningfully jumps a
#     defensible boundary in a non-Santa-Ana wind regime.
#   - flood:         240 s before urban water levels reach knee-deep
#     once a storm drain has burst.
T_MAX_BY_TYPE = {
    "building_fire": 240.0,
    "wildfire":      300.0,
    "flood":         240.0,
}

# Per-severity peak civilian impact when the disaster reaches T_max.
MAX_CASUALTIES_BY_SEVERITY = {
    "low":      2,
    "medium":   12,
    "high":     45,
    "critical": 200,
}

# Property damage at T_max in USD, by disaster type × severity bucket.
# Order-of-magnitude figures; the AI's response time scales these down
# the same way it scales casualties.
MAX_PROPERTY_DAMAGE_USD = {
    "building_fire": {"low": 30_000,  "medium": 150_000, "high":   750_000, "critical": 3_000_000},
    "wildfire":      {"low":  5_000,  "medium":  50_000, "high":   400_000, "critical": 1_500_000},
    "flood":         {"low": 25_000,  "medium": 200_000, "high": 1_000_000, "critical": 4_000_000},
}

TRUCK_SPEED_MPS = 13.4  # ~30 mph in city traffic

# Project root — run logs land here, one per run, timestamped.
PROJECT_ROOT = Path(__file__).resolve().parents[2]


# ── Stations (6, distributed end-to-end of Manhattan) ──────────────────
# Coverage rationale:
#   - Engine 95  → Inwood / Washington Heights (top of the island)
#   - Engine 36  → Harlem / Morningside
#   - Engine 84  → UWS / Central Park N
#   - Engine 23  → Midtown / Central Park S
#   - Engine 7   → Tribeca / Lower East Side / SoHo
#   - Engine 4   → Battery / Financial District (bottom of the island)
# 16 trucks each = 96 total — Gemini routinely asks for 5-10 per critical
# incident, and 8 concurrent fires cluster their requests on Engine
# 84/23/36, so the per-station headroom matters more than raw fleet size.

STATIONS = [
    {"name": "Engine 95 (Inwood)",      "lat": 40.8650, "lng": -73.9270, "truck_count": 16},
    {"name": "Engine 36 (Harlem)",      "lat": 40.8160, "lng": -73.9460, "truck_count": 16},
    {"name": "Engine 84 (UWS)",         "lat": 40.8000, "lng": -73.9700, "truck_count": 16},
    {"name": "Engine 23 (Midtown)",     "lat": 40.7670, "lng": -73.9870, "truck_count": 16},
    {"name": "Engine 7 (Tribeca/LES)",  "lat": 40.7180, "lng": -74.0080, "truck_count": 16},
    {"name": "Engine 4 (Battery)",      "lat": 40.7050, "lng": -74.0100, "truck_count": 16},
]


# ── Disasters (8, varied type / severity / neighborhood) ───────────────


SCENARIOS = [
    {
        "label": "UWS apartment fire",
        "operator_type": "Building_Fire", "operator_severity": 5,
        "nlu_type": "building_fire",
        "lat": 40.7820, "lng": -73.9760,
        "transcript": (
            "Massive fire in a residential building on the Upper West Side. "
            "Flames out of three windows on the upper floors. People are "
            "trapped on the fire escape and screaming. Two unconscious on "
            "the sidewalk after a partial cornice collapse."
        ),
    },
    {
        "label": "Midtown office fire",
        "operator_type": "Building_Fire", "operator_severity": 4,
        "nlu_type": "building_fire",
        "lat": 40.7570, "lng": -73.9830,
        "transcript": (
            "Heavy smoke and visible flames on the 12th floor of an office "
            "tower in Midtown. Hundreds evacuating into the street. No "
            "casualties confirmed yet but the fire is spreading floor-to-"
            "floor."
        ),
    },
    {
        "label": "Harlem brownstone fire",
        "operator_type": "Building_Fire", "operator_severity": 3,
        "nlu_type": "building_fire",
        "lat": 40.8120, "lng": -73.9460,
        "transcript": (
            "Single brownstone in Harlem fully alight on the second floor. "
            "Family on the front stoop, all accounted for. Visible flames "
            "but no immediate spread to neighbours."
        ),
    },
    {
        "label": "Inwood Hill wildfire",
        "operator_type": "Wildfire", "operator_severity": 5,
        "nlu_type": "wildfire",
        "lat": 40.8730, "lng": -73.9230,
        "transcript": (
            "Huge wildfire ripping through Inwood Hill Park. Tree line is "
            "fully engulfed and flames are jumping toward the houses on "
            "Payson Avenue. Several joggers reported missing in the smoke."
        ),
    },
    {
        "label": "Central Park N brushfire",
        "operator_type": "Wildfire", "operator_severity": 3,
        "nlu_type": "wildfire",
        "lat": 40.7990, "lng": -73.9580,
        "transcript": (
            "Brushfire in the North Woods of Central Park. Visible flames "
            "in dry undergrowth but contained to a clearing for now. No "
            "casualties; park staff is keeping bystanders back."
        ),
    },
    {
        "label": "Central Park S brushfire",
        "operator_type": "Wildfire", "operator_severity": 4,
        "nlu_type": "wildfire",
        "lat": 40.7700, "lng": -73.9750,
        "transcript": (
            "Wildfire spreading through trees on the south end of Central "
            "Park near the Pond. Thick smoke pouring over 59th Street and "
            "a horse-carriage driver has been knocked unconscious."
        ),
    },
    {
        "label": "Lower East Side flood",
        "operator_type": "Flood", "operator_severity": 5,
        "nlu_type": "flood",
        "lat": 40.7150, "lng": -73.9870,
        "transcript": (
            "Catastrophic flooding on the Lower East Side. Water at car-"
            "roof level on Houston Street. Multiple stranded vehicles with "
            "people stuck inside. Water still rising."
        ),
    },
    {
        "label": "Financial District flooding",
        "operator_type": "Flood", "operator_severity": 4,
        "nlu_type": "flood",
        "lat": 40.7060, "lng": -74.0100,
        "transcript": (
            "Heavy flooding around Wall Street, water up to the curb and "
            "into ground-floor lobbies. Pedestrians wading through; no "
            "injuries yet but traffic is gridlocked and a storm drain has "
            "burst."
        ),
    },
]


# ── Helpers ────────────────────────────────────────────────────────────


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_station(lat, lng):
    """Return (name, distance_m) of the station closest to (lat, lng)."""
    best = min(STATIONS, key=lambda s: haversine_m(lat, lng, s["lat"], s["lng"]))
    return best["name"], haversine_m(lat, lng, best["lat"], best["lng"])


def nearest_station_distance_m(lat, lng):
    return nearest_station(lat, lng)[1]


def severity_int_to_str(n):
    if n <= 3: return "low"
    if n <= 5: return "medium"
    if n <= 7: return "high"
    return "critical"


def reset_state(client, conn):
    client.delete("/api/disasters")
    with conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM active_dispatches;")
            cur.execute("DELETE FROM citizen_reports;")
            cur.execute("DELETE FROM cordons;")
    GLOBAL_LOG_BUFFER.clear()


def place_stations(client):
    # Wipe any existing stations first to keep the test deterministic.
    res = client.get("/api/fire-stations")
    for s in res.json().get("stations", []):
        client.delete(f"/api/fire-stations/{s['id']}")
    for s in STATIONS:
        r = client.post("/api/fire-stations", json=s)
        r.raise_for_status()


def trigger_disaster(client, sc) -> str:
    payload = {
        "id": str(uuid.uuid4()),
        "disaster_type": sc["operator_type"],
        "severity": sc["operator_severity"],
        "geometry": {"type": "Point", "coordinates": [sc["lng"], sc["lat"]]},
        "geometry_kind": "point",
        "status": "active",
        "source": "operator",
    }
    r = client.post("/api/trigger-disaster", json=payload)
    r.raise_for_status()
    return r.json()["event_id"]


# Mutex around audit-log reads — deque is thread-safe but iteration during
# concurrent appends can hand back inconsistent slices on some Pythons.
_LOG_LOCK = threading.Lock()


def fire_one_scenario(client, sc, op_event_id):
    """One thread per scenario. Fires its citizen reports, waits for the
    pipeline (TestClient awaits BackgroundTasks before .post() returns)."""
    started = time.time()
    offsets = [(0.0001, 0.0001), (-0.0001, 0.0002), (0.0002, -0.0001)]
    reports = []
    for i, (dlat, dlng) in enumerate(offsets):
        reports.append({
            "event_id": op_event_id,
            "citizen_idx": 7000 + i,
            "report_kind": "observation",
            "location": {"lat": sc["lat"] + dlat, "lng": sc["lng"] + dlng},
            "transcript": sc["transcript"],
            "perceived_severity": sc["operator_severity"],
        })
    r = client.post("/api/citizen-report", json={"reports": reports})
    r.raise_for_status()
    elapsed = time.time() - started
    return {"label": sc["label"], "op_event_id": op_event_id, "elapsed_s": elapsed}


def collect_results(conn, sc):
    """Find the AI-declared row for this scenario's NLU type at this
    scenario's coordinates. Multiple concurrent scenarios may share an
    NLU type — disambiguate by proximity."""
    target_lat, target_lng = sc["lat"], sc["lng"]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, disaster_type, severity, location_estimate
            FROM disaster_events
            WHERE disaster_type = %s
            """,
            (sc["nlu_type"],),
        )
        rows = cur.fetchall()
    best = None
    best_d = float("inf")
    for row in rows:
        loc = row[3] or {}
        if not loc.get("lat") or not loc.get("lng"):
            continue
        d = haversine_m(target_lat, target_lng, loc["lat"], loc["lng"])
        if d < best_d:
            best_d = d
            best = {"id": str(row[0]), "severity": row[2], "lat": loc["lat"], "lng": loc["lng"]}
    if best is None:
        return None, None
    return best, best_d


def query_dispatches(conn, incident_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT unit_count, target_lat, target_lng FROM active_dispatches WHERE event_id = %s;",
            (incident_id,),
        )
        rows = cur.fetchall()
    return rows


def find_plan_rationale(incident_id):
    with _LOG_LOCK:
        for ev in reversed(list(GLOBAL_LOG_BUFFER)):
            if ev.get("event_type") != "DECISION":
                continue
            details = ev.get("details", {})
            if incident_id in (details.get("context") or ""):
                return details.get("rationale")
    return None


# ── Main flow ──────────────────────────────────────────────────────────


def main_entry():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with TestClient(main.app) as client:
            print(f"GOOGLE_CLOUD_PROJECT = {os.environ.get('GOOGLE_CLOUD_PROJECT')!r}")
            print(f"Stations: {len(STATIONS)}  -  Disasters: {len(SCENARIOS)}")

            # 1. Setup — clean state + stations + operator disasters (sequential).
            reset_state(client, conn)
            place_stations(client)

            triggered = {}
            for sc in SCENARIOS:
                eid = trigger_disaster(client, sc)
                triggered[sc["label"]] = eid
            print(f"\nTriggered {len(triggered)} operator disasters.")

            # 2. CONCURRENT FIRE: every scenario's citizen-reports batch fires
            #    in parallel. TestClient awaits BackgroundTasks before .post()
            #    returns, so each thread blocks until its pipeline run is done.
            run_started_dt = datetime.now(timezone.utc)
            wall_started = time.time()
            with ThreadPoolExecutor(max_workers=len(SCENARIOS)) as ex:
                futures = {
                    ex.submit(fire_one_scenario, client, sc, triggered[sc["label"]]): sc
                    for sc in SCENARIOS
                }
                fire_results = {}
                for fut in as_completed(futures):
                    sc = futures[fut]
                    try:
                        fire_results[sc["label"]] = fut.result()
                    except Exception as exc:
                        print(f"  scenario {sc['label']} CRASHED: {exc}")
                        fire_results[sc["label"]] = {"error": str(exc), "elapsed_s": None}
            wall_elapsed = time.time() - wall_started
            print(f"\nAll 8 pipelines complete in {wall_elapsed:.2f}s wall-clock.")

            # Diagnostics: every declare_incident audit event + every AI row in DB.
            print("\n[diag] declare_incident events:")
            for ev in GLOBAL_LOG_BUFFER:
                if ev.get("event_type") == "TOOL_CALL" and ev["details"].get("tool_name") == "declare_incident":
                    a = ev["details"]["arguments"]
                    print(f"  {a.get('incident_type')}  sev={a.get('severity')}  "
                          f"({a.get('centroid', {}).get('lat'):.4f},{a.get('centroid', {}).get('lng'):.4f})  "
                          f"n_reports={a.get('n_reports')}")
            print("\n[diag] AI-declared disaster_events rows (NLU-lowercase types):")
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT disaster_type, severity, location_estimate, created_at "
                    "FROM disaster_events WHERE disaster_type IN ('building_fire','wildfire','flood') "
                    "ORDER BY created_at DESC;"
                )
                for r in cur.fetchall():
                    loc = r[2] or {}
                    print(f"  {r[0]:14s} sev={r[1]} loc=({loc.get('lat')},{loc.get('lng')})")

            # 3. Collect per-scenario metrics.
            per_scenario = []
            for sc in SCENARIOS:
                fr = fire_results.get(sc["label"], {})
                latency = fr.get("elapsed_s")
                ai_row, tri_error = collect_results(conn, sc)
                station_name, station_dist_m = nearest_station(sc["lat"], sc["lng"])

                # Default everything to the "we didn't make it" branch and
                # override when we successfully dispatched.
                op_sev_str = severity_int_to_str(sc["operator_severity"])
                lives_at_risk_default = MAX_CASUALTIES_BY_SEVERITY[op_sev_str]
                damage_default = MAX_PROPERTY_DAMAGE_USD.get(
                    sc["nlu_type"], MAX_PROPERTY_DAMAGE_USD["building_fire"]
                )[op_sev_str]

                row = {
                    "label": sc["label"],
                    "operator_type": sc["operator_type"],
                    "operator_severity": sc["operator_severity"],
                    "nlu_type": sc["nlu_type"],
                    "location": {"lat": sc["lat"], "lng": sc["lng"]},
                    "latency_s": latency,
                    "declared": ai_row is not None,
                    "triangulation_m": tri_error,
                    "ai_severity": ai_row["severity"] if ai_row else None,
                    "ai_severity_bucket": (
                        severity_int_to_str(ai_row["severity"]) if ai_row else None
                    ),
                    "units": 0,
                    "nearest_station": station_name,
                    "nearest_station_distance_m": round(station_dist_m, 1),
                    "truck_eta_s": round(station_dist_m / TRUCK_SPEED_MPS, 1),
                    "time_to_scene_s": None,
                    "t_max_s": T_MAX_BY_TYPE.get(sc["nlu_type"], 240.0),
                    "combatted": False,
                    "lives_at_risk": lives_at_risk_default,
                    "lives_lost": lives_at_risk_default,
                    "lives_saved": 0,
                    "property_damage_usd": damage_default,
                    "rationale": None,
                }

                if ai_row is None:
                    # No declare → no response → full impact.
                    per_scenario.append(row)
                    continue

                disps = query_dispatches(conn, ai_row["id"])
                units = sum(d[0] for d in disps)
                row["units"] = units

                eta_s = station_dist_m / TRUCK_SPEED_MPS
                time_to_scene = (latency or 0) + eta_s
                row["time_to_scene_s"] = round(time_to_scene, 1)
                t_max = row["t_max_s"]

                row["rationale"] = find_plan_rationale(ai_row["id"])

                if units <= 0:
                    # AI declared but didn't dispatch (e.g. agent timeout,
                    # all stations clamped to zero by stale snapshot).
                    # Treat as un-combatted — full impact.
                    pass
                else:
                    # Quadratic curve: a response at half T_max yields ~25%
                    # casualties; right at T_max yields 100%; faster than
                    # the standard window saves disproportionately more.
                    raw_ratio = time_to_scene / t_max
                    ratio = min(1.0, raw_ratio * raw_ratio)
                    row["combatted"] = (time_to_scene < t_max)
                    ai_sev_str = severity_int_to_str(ai_row["severity"])
                    row["lives_at_risk"] = MAX_CASUALTIES_BY_SEVERITY[ai_sev_str]
                    row["lives_lost"] = int(round(row["lives_at_risk"] * ratio))
                    row["lives_saved"] = row["lives_at_risk"] - row["lives_lost"]
                    damage_max = MAX_PROPERTY_DAMAGE_USD.get(
                        sc["nlu_type"], MAX_PROPERTY_DAMAGE_USD["building_fire"]
                    )[ai_sev_str]
                    row["property_damage_usd"] = int(round(damage_max * ratio))

                per_scenario.append(row)

            # 4. Per-scenario detail.
            print("\n" + "=" * 110)
            print("PER-SCENARIO RESULTS")
            print("=" * 110)
            for r in per_scenario:
                print(f"\n  {r['label']}  ({r['operator_type']} sev{r['operator_severity']})")
                print(f"    location: ({r['location']['lat']}, {r['location']['lng']})")
                print(f"    nearest station: {r['nearest_station']}  ({r['nearest_station_distance_m']:.0f}m, truck ETA {r['truck_eta_s']:.0f}s)")
                if not r["declared"]:
                    print(f"    NOT DECLARED  -  lives lost: {r['lives_lost']}  property damage: ${r['property_damage_usd']:,}")
                    continue
                tri = f"{r['triangulation_m']:.0f}m" if r["triangulation_m"] is not None else "n/a"
                lat_s = f"{r['latency_s']:.1f}s" if r["latency_s"] is not None else "n/a"
                tts = f"{r['time_to_scene_s']:.1f}s" if r["time_to_scene_s"] is not None else "n/a"
                print(f"    declared(sev={r['ai_severity']} / {r['ai_severity_bucket']})  "
                      f"tri-err={tri}  pipeline={lat_s}  units={r['units']}")
                print(f"    time-to-scene={tts}  T_max={r['t_max_s']:.0f}s  -> "
                      f"{'COMBATTED' if r['combatted'] else 'TOO LATE'}")
                print(f"    lives at risk: {r['lives_at_risk']}  saved: {r['lives_saved']}  lost: {r['lives_lost']}")
                print(f"    property damage: ${r['property_damage_usd']:,}")
                if r["rationale"]:
                    print(f"    rationale: {r['rationale']}")

            # 5. Summary table.
            print("\n" + "=" * 124)
            print("STRESS-TEST SUMMARY")
            print("=" * 124)
            hdr = (f"  {'Scenario':35s}  {'Decl':>4s}  {'Tri':>5s}  {'Units':>5s}  "
                   f"{'TTS':>7s}  {'OK':>4s}  {'Saved':>5s}  {'Lost':>5s}  {'Damage':>12s}")
            print(hdr)
            print("  " + "-" * (len(hdr) - 2))
            declared_n = combatted_n = 0
            total_lost = total_saved = total_damage = 0
            for r in per_scenario:
                tri = f"{r['triangulation_m']:.0f}m" if r.get("triangulation_m") is not None else "—"
                units = str(r["units"]) if r["declared"] else "—"
                tts = f"{r['time_to_scene_s']:.1f}s" if r.get("time_to_scene_s") is not None else "—"
                if r["declared"]: declared_n += 1
                if r.get("combatted"): combatted_n += 1
                total_lost += r["lives_lost"]
                total_saved += r["lives_saved"]
                total_damage += r["property_damage_usd"]
                ok = "OK" if (r["declared"] and r.get("combatted")) else "FAIL"
                print(f"  {r['label']:35s}  {('y' if r['declared'] else 'n'):>4s}  "
                      f"{tri:>5s}  {units:>5s}  {tts:>7s}  {ok:>4s}  "
                      f"{r['lives_saved']:>5d}  {r['lives_lost']:>5d}  ${r['property_damage_usd']:>10,}")
            print()
            print(f"  Declared:           {declared_n}/{len(SCENARIOS)}")
            print(f"  Combatted in time:  {combatted_n}/{len(SCENARIOS)}")
            print(f"  Lives saved (est):  {total_saved}")
            print(f"  Lives lost  (est):  {total_lost}")
            print(f"  Property damage (est): ${total_damage:,}")
            print(f"  Wall-clock for {len(SCENARIOS)} concurrent pipelines: {wall_elapsed:.2f}s")

            # 6. Persist the run as a JSON log file in the project root.
            run_started_iso = run_started_dt.isoformat()
            run_completed_iso = datetime.now(timezone.utc).isoformat()
            log_payload = {
                "run_started_at": run_started_iso,
                "run_completed_at": run_completed_iso,
                "wall_clock_seconds": round(wall_elapsed, 2),
                "stations": STATIONS,
                "totals": {
                    "scenarios": len(SCENARIOS),
                    "declared": declared_n,
                    "combatted_in_time": combatted_n,
                    "lives_saved": total_saved,
                    "lives_lost": total_lost,
                    "property_damage_usd": total_damage,
                },
                "disasters": per_scenario,
            }
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            out_path = PROJECT_ROOT / f"stress_run_{ts}.json"
            out_path.write_text(json.dumps(log_payload, indent=2), encoding="utf-8")
            print(f"\nRun log written to: {out_path}")

            # Cleanup so the next run starts from scratch.
            reset_state(client, conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main_entry()
