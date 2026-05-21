"""One-off wipe of AI-generated event data from the Sentinel-City DB.

Clears:
  - disaster_events       (incidents the operator triggered or the AI declared)
  - citizen_reports       (911 calls from the citizen sim)
  - cordons               (exclusion zones)
  - notifications         (AI-published citizen alerts)
Resets the "currently dispatched" counters on the three station types so the
fleet roster reflects a clean slate:
  - fire_stations.trucks_dispatched      → 0
  - hospitals.ambulances_dispatched      → 0
  - police_stations.police_dispatched    → 0

Does NOT touch the station/hospital rows themselves (static city geography).

Runs in a single transaction. Prints BEFORE and AFTER counts so you see
exactly what changed before the commit lands.

Usage:
    python scripts/wipe_events.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
load_dotenv(BACKEND / ".env")

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set in environment (or .env)")
    sys.exit(1)

# Tables to fully DELETE
DELETE_TABLES = ["disaster_events", "citizen_reports", "cordons", "notifications"]

# (table, column) pairs to reset to 0
RESET_COUNTERS = [
    ("fire_stations",   "trucks_dispatched"),
    ("hospitals",       "ambulances_dispatched"),
    ("police_stations", "police_dispatched"),
]


def _count(cur, table: str) -> int:
    cur.execute(f"SELECT COUNT(*) FROM {table};")
    return cur.fetchone()[0]


def _sum(cur, table: str, col: str) -> int:
    cur.execute(f"SELECT COALESCE(SUM({col}), 0) FROM {table};")
    return cur.fetchone()[0]


def main() -> None:
    # Mask credentials when printing — show only the host so the user can
    # confirm they're hitting the right DB.
    safe_url = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Connecting to: {safe_url}")
    print()

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                # ── BEFORE snapshot ────────────────────────────────────
                print("BEFORE:")
                before_counts = {}
                for t in DELETE_TABLES:
                    try:
                        n = _count(cur, t)
                    except psycopg2.errors.UndefinedTable:
                        print(f"  {t:20s} (table does not exist — skipping)")
                        before_counts[t] = None
                        conn.rollback()  # clear transaction error state
                        cur = conn.cursor()
                        continue
                    before_counts[t] = n
                    print(f"  {t:20s} rows = {n}")
                before_sums = {}
                for table, col in RESET_COUNTERS:
                    try:
                        s = _sum(cur, table, col)
                    except psycopg2.errors.UndefinedTable:
                        print(f"  {table}.{col} (table does not exist — skipping)")
                        before_sums[(table, col)] = None
                        conn.rollback()
                        cur = conn.cursor()
                        continue
                    before_sums[(table, col)] = s
                    print(f"  SUM({table}.{col}) = {s}")
                print()

                # ── Apply the wipe ─────────────────────────────────────
                deleted = {}
                for t in DELETE_TABLES:
                    if before_counts.get(t) is None:
                        continue
                    cur.execute(f"DELETE FROM {t};")
                    deleted[t] = cur.rowcount
                for table, col in RESET_COUNTERS:
                    if before_sums.get((table, col)) is None:
                        continue
                    cur.execute(f"UPDATE {table} SET {col} = 0 WHERE {col} <> 0;")
                    deleted[f"{table}.{col} -> 0"] = cur.rowcount

                # ── AFTER snapshot (still inside tx, pre-commit) ──────
                print("AFTER (in transaction, pre-commit):")
                for t in DELETE_TABLES:
                    if before_counts.get(t) is None:
                        continue
                    print(f"  {t:20s} rows = {_count(cur, t)}")
                for table, col in RESET_COUNTERS:
                    if before_sums.get((table, col)) is None:
                        continue
                    print(f"  SUM({table}.{col}) = {_sum(cur, table, col)}")
                print()

                print("Changes (will be committed when this block exits cleanly):")
                for k, v in deleted.items():
                    print(f"  {k}: {v} row(s) affected")
        # `with conn:` commits on clean exit, rolls back on exception.
        print()
        print("COMMIT successful.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
