"""End-to-end test: City Resilience Heatmap + AI insight.

Drives the real FastAPI app against the real Postgres + real Vertex AI to prove
the full admin-heatmap flow:

  1. Seed sparse emergency resources (one hospital + one fire station + one
     police station) clustered downtown, FAR from where the disasters happen --
     so the AI has a real reason to recommend adding resources elsewhere.
  2. Create multiple disasters across the city (people_inside + safe_exit_pct =>
     real "infrastructure damaged" / at-risk weight).
  3. Make people die: post responder casualty reports (critical/injured/fainted)
     at each disaster site.
  4. Assert /api/city-heatmap returns REAL aggregated data (non-empty casualty
     and damage layers) -- not the empty placeholder.
  5. Assert /api/city-insight (live Gemini) returns status="done" with at least
     one recommendation that has BOTH a concrete action AND a reason. Print every
     recommendation so a human can judge the advice quality.
  6. Show the now-real /api/savings-summary numbers as a bonus.

FastAPI's TestClient awaits async BackgroundTasks before .post() returns, so the
casualty auto-dispatch has fully run by the time we check. No polling.

Run with `python test_city_insight_e2e.py` from backend/. Requires a working
DATABASE_URL and Vertex creds (GOOGLE_CLOUD_PROJECT / GOOGLE_APPLICATION_CREDENTIALS)
in .env. Burns a few cents of Vertex quota (one city-insight call).

NOTE: this test OWNS the heatmap-input tables for the duration of the run -- it
wipes disaster_events, responder_reports, active_dispatches, and the three station
tables, then seeds its own. Point it at a dev/test database.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

# Load .env BEFORE importing the app (DATABASE_URL + Vertex creds).
load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402  - imports the FastAPI app


# Resources clustered in Lower Manhattan -- deliberately far from every disaster
# below, so nearest-service distances are kilometres and the AI has grounds to
# recommend adding capacity near the hotspots.
RESOURCE_HUB = {"lat": 40.7061, "lng": -74.0087}

# Disasters spread across Manhattan (the resource hub sits at the southern tip,
# so upper-Manhattan sites are still kilometres away). Each carries an at-risk
# estimate (people_inside * (1 - safe_exit_pct/100)) so the damage layer is
# weighted by real exposure, not just severity.
DISASTER_SITES = [
    {"label": "Harlem high-rise fire", "type": "Building_Fire", "severity": 7,
     "lat": 40.8116, "lng": -73.9465, "people_inside": 220, "safe_exit_pct": 55},
    {"label": "Washington Heights gas explosion", "type": "Building_Fire", "severity": 8,
     "lat": 40.8417, "lng": -73.9393, "people_inside": 180, "safe_exit_pct": 50},
    {"label": "Upper East Side flood", "type": "Flood", "severity": 5,
     "lat": 40.7736, "lng": -73.9566, "people_inside": 90, "safe_exit_pct": 70},
    {"label": "Central Park brush fire", "type": "Wildfire", "severity": 5,
     "lat": 40.7829, "lng": -73.9654, "people_inside": 60, "safe_exit_pct": 75},
    {"label": "Lower East Side building collapse", "type": "Building_Fire", "severity": 6,
     "lat": 40.7220, "lng": -73.9870, "people_inside": 140, "safe_exit_pct": 60},
]

# Per-site casualty mix ("people die"). critical is the fatality proxy.
CASUALTY_MIX = [
    ("casualty_critical", 9),
    ("casualty_injured", 7),
    ("casualty_fainted", 5),
]


def reset_state(client: TestClient, conn) -> None:
    """Wipe the heatmap-input tables + the station tables so the run is
    deterministic. The test re-seeds everything it needs afterward."""
    client.delete("/api/disasters")  # clears disasters + linked cordons/dispatches/CCTV
    with conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM responder_reports;")
            cur.execute("DELETE FROM active_dispatches;")
            cur.execute("DELETE FROM disaster_events;")
            cur.execute("DELETE FROM hospitals;")
            cur.execute("DELETE FROM fire_stations;")
            cur.execute("DELETE FROM police_stations;")


def seed_resources(client: TestClient) -> None:
    """One hospital + one fire station + one police station, all at the downtown
    hub far from the disaster sites. Generous ambulance capacity so casualty
    auto-dispatch resolves (drives lives_saved on the savings tile)."""
    r = client.post("/api/hospitals", json={
        "name": "Downtown General", "lat": RESOURCE_HUB["lat"], "lng": RESOURCE_HUB["lng"],
        "ambulance_count": 30,
    })
    r.raise_for_status()
    r = client.post("/api/fire-stations", json={
        "name": "Downtown Engine 1", "lat": RESOURCE_HUB["lat"] + 0.0015,
        "lng": RESOURCE_HUB["lng"] - 0.0013, "truck_count": 8,
    })
    r.raise_for_status()
    r = client.post("/api/police-stations", json={
        "name": "1st Precinct", "lat": RESOURCE_HUB["lat"] + 0.0030,
        "lng": RESOURCE_HUB["lng"] + 0.0037, "police_count": 20,
    })
    r.raise_for_status()


def create_disaster(client: TestClient, site: dict) -> str:
    payload = {
        "id": str(uuid.uuid4()),
        "disaster_type": site["type"],
        "severity": site["severity"],
        "geometry": {"type": "Point", "coordinates": [site["lng"], site["lat"]]},
        "geometry_kind": "point",
        "status": "active",
        "source": "operator",
        "people_inside": site["people_inside"],
        "safe_exit_pct": site["safe_exit_pct"],
        "notes": site["label"],
    }
    res = client.post("/api/trigger-disaster", json=payload)
    res.raise_for_status()
    return res.json()["event_id"]


def fire_casualties(client: TestClient, event_id: str, site: dict) -> int:
    """Post the casualty mix for one site, jittered ~10-30 m apart so they stay
    in the same cluster cell. Returns the number of reports posted."""
    reports = []
    n = 0
    for kind, count in CASUALTY_MIX:
        for i in range(count):
            dlat = ((i % 3) - 1) * 0.0002
            dlng = ((i // 3 % 3) - 1) * 0.0002
            reports.append({
                "event_id": event_id,
                "responder_unit_id": f"unit-{site['type'][:3].lower()}-{n}",
                "report_kind": kind,
                "location": {"lat": site["lat"] + dlat, "lng": site["lng"] + dlng},
                "severity": site["severity"],
            })
            n += 1
    res = client.post("/api/responder-report", json={"reports": reports})
    res.raise_for_status()
    return n


def main_entry() -> int:
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    failures: list[str] = []
    try:
        with TestClient(main.app) as client:
            # -- Arrange --------------------------------------------------
            print("-> Resetting state and seeding sparse downtown resources...")
            reset_state(client, conn)
            seed_resources(client)

            print(f"-> Creating {len(DISASTER_SITES)} disasters across the city...")
            total_casualties = 0
            for site in DISASTER_SITES:
                eid = create_disaster(client, site)
                posted = fire_casualties(client, eid, site)
                total_casualties += posted
                print(f"   - {site['label']:<32} sev={site['severity']}  "
                      f"at-risk~{int(site['people_inside'] * (1 - site['safe_exit_pct']/100))}  "
                      f"casualties={posted}")
            print(f"   total casualty reports posted: {total_casualties}")

            # -- Assert 1: heatmap is real, not the empty placeholder -----
            print("\n-> GET /api/city-heatmap")
            hm = client.get("/api/city-heatmap")
            hm.raise_for_status()
            hm = hm.json()
            cas = hm.get("casualties", {})
            dmg = hm.get("damage", {})
            print(f"   casualties: count={cas.get('count')}  by_kind={cas.get('by_kind')}  "
                  f"max_weight={cas.get('max_weight')}")
            print(f"   damage:     count={dmg.get('count')}  "
                  f"total_est_fatalities={dmg.get('total_est_fatalities')}  "
                  f"max_weight={dmg.get('max_weight')}")

            if not (cas.get("count", 0) > 0 and cas.get("points")):
                failures.append("heatmap casualty layer is empty (expected real data)")
            if not (dmg.get("count", 0) > 0 and dmg.get("points")):
                failures.append("heatmap damage layer is empty (expected real data)")
            if sum((cas.get("by_kind") or {}).values()) == 0:
                failures.append("heatmap by_kind counts are all zero")

            # -- Assert 2: AI insight is real AND reasoned ----------------
            print("\n-> GET /api/city-insight  (live Gemini -- may take a few seconds)")
            ci = client.get("/api/city-insight")
            ci.raise_for_status()
            ci = ci.json()
            status = ci.get("status")
            recs = ci.get("recommendations") or []
            print(f"   status={status}  model={ci.get('model')}")
            print(f"   title:   {ci.get('title')}")
            print(f"   summary: {ci.get('summary')}")
            print(f"   {len(recs)} recommendation(s):")
            for i, r in enumerate(recs, 1):
                print(f"     {i}. [{r.get('priority')}] {r.get('action')}")
                print(f"        why:    {r.get('rationale')}")
                print(f"        where:  {r.get('target_area')}")

            if status != "done":
                failures.append(
                    f"city-insight status={status!r} (expected 'done'; "
                    f"'unavailable' usually means Vertex creds/connectivity)"
                )
            # Pass criterion: at least one rec suggests a change (action) AND
            # gives a reason (rationale) -- both non-empty.
            reasoned = [
                r for r in recs
                if (r.get("action") or "").strip() and (r.get("rationale") or "").strip()
            ]
            if not reasoned:
                failures.append("no recommendation has both a non-empty action and rationale")

            # -- Bonus: savings tiles are now real ------------------------
            print("\n-> GET /api/savings-summary  (now DB-derived)")
            sv = client.get("/api/savings-summary").json()
            print(f"   lives_saved={sv.get('lives_saved')}  "
                  f"infrastructure_value_usd={sv.get('infrastructure_value_usd'):,}  "
                  f"money_saved_usd={sv.get('money_saved_usd'):,}")
            for metric in ("lives", "infrastructure", "money"):
                ins = client.get(f"/api/savings-summary/insight?metric={metric}").json()
                print(f"   [{metric}] {ins.get('title')}")

            # -- Cleanup --------------------------------------------------
            # Pass --keep (or set KEEP_DATA=1) to leave the seeded incidents in
            # the DB so the mobile heatmap stays populated for a demo.
            keep = "--keep" in sys.argv or os.environ.get("KEEP_DATA") == "1"
            if keep:
                print("\n-> Keeping seeded incident data (--keep): mobile heatmap "
                      "will show this history.")
            else:
                print("\n-> Cleaning up test fixtures... (pass --keep to retain them)")
                reset_state(client, conn)
    finally:
        conn.close()

    print("\n" + "=" * 60)
    if failures:
        print("RESULT: FAIL")
        for f in failures:
            print(f"  x {f}")
        return 1
    print("RESULT: PASS -- heatmap returned real data and the AI gave a reasoned "
          "resource-placement recommendation.")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
