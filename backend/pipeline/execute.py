"""Pipeline executor — row-locked Supabase mutations.

End-to-end driver for one citizen report through the pipeline:
    extract → cluster → decide → execute

Every write opens a transaction with ``SELECT ... FOR UPDATE`` on the
rows it intends to mutate so concurrent FastAPI workers can't over-
dispatch on identical simultaneous reports (plan §Concurrency).

Locking strategy:
  - Dispatch: lock ``fire_stations`` row by id. Re-read trucks_dispatched
    after the lock, recompute available, run policy.validate_dispatch
    against the FRESH count, then UPDATE.
  - Declare:  use a Postgres advisory lock keyed on
    ``(incident_type, geohash_5)`` so two workers can't both insert
    a new disaster_events row for the same incident.
  - Cordon / alert: low concurrency risk; standard transactions.

The Pydantic + policy.validate_* checks run BEFORE the transaction so
malformed inputs never even open one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional, Tuple

import psycopg2

from audit import AuditLogger
from metrics import inc as _metric_inc
from pipeline._geom import to_geom_sql, to_geom_params
from pipeline.cluster import find_cluster, MIN_REPORTS_TO_DECLARE
from pipeline.decide import (
    DeclareIncident,
    DispatchOrder,
    ResponsePlan,
    plan_response,
    should_declare,
)
from pipeline.extract import (
    ReportExtraction,
    extract_report,
    model_version,
    transcript_hash,
)
from pipeline.world_slice import IncidentRef, WorldSlice, slice_for_incident
from safety import policy as _policy

logger = logging.getLogger(__name__)


DATABASE_URL = os.environ.get("DATABASE_URL", "")
PIPELINE_AGENT_ID = "agent-sentinel-pipeline"

# One shared AuditLogger across pipeline calls. Writes to the same
# GLOBAL_LOG_BUFFER the legacy AI loops used, so the operator dashboard's
# AI Logs & Reasoning panel surfaces every pipeline event with no UI changes.
_AUDIT = AuditLogger()


# ── Top-level entry point ───────────────────────────────────────────────


async def process_report(report_id: str) -> Dict[str, Any]:
    """Drive one citizen report through the pipeline.

    Idempotent — safe to call repeatedly on the same report_id. The
    geom/nlu_extraction columns short-circuit re-work. Every meaningful
    stage emits an audit event into the GLOBAL_LOG_BUFFER so the operator
    dashboard's AI Logs panel surfaces pipeline activity.
    """
    trace: Dict[str, Any] = {
        "report_id": report_id,
        "stage": "start",
        "declared_incident_id": None,
        "extraction": None,
        "plan": None,
    }

    if not DATABASE_URL:
        trace["stage"] = "skip_no_db"
        return trace

    _metric_inc("pipeline.report_processed")
    try:
        # 1. Load the raw report row + ensure geom + nlu_extraction populated
        conn = _connect()
        try:
            row = _load_report(conn, report_id)
            if row is None:
                trace["stage"] = "report_not_found"
                _AUDIT.log_recovery_action(
                    PIPELINE_AGENT_ID,
                    f"process_report({report_id}): row not found",
                    "skip — likely a stale background task; nothing to do",
                )
                return trace
            transcript = row["transcript"]
            lat = row["lat"]
            lng = row["lng"]
            if lat is None or lng is None:
                trace["stage"] = "no_coords"
                _AUDIT.log_recovery_action(
                    PIPELINE_AGENT_ID,
                    f"process_report({report_id}): missing device coordinates",
                    "skip — cannot plan dispatch without lat/lng",
                )
                return trace
            _ensure_geom(conn, report_id, lat, lng)

            # 2. NLU extraction (cache-first)
            extraction = _cache_lookup(conn, transcript)
            cache_hit = extraction is not None
            if cache_hit:
                _metric_inc("pipeline.nlu_cache_hit")
            else:
                _metric_inc("pipeline.nlu_cache_miss")
                extraction = await extract_report(transcript)
                if extraction is not None:
                    _cache_store(conn, transcript, extraction)
            if extraction is None:
                trace["stage"] = "extract_failed"
                _AUDIT.log_recovery_action(
                    PIPELINE_AGENT_ID,
                    f"process_report({report_id}): NLU extraction failed",
                    "skip — transcript could not be classified",
                )
                return trace
            trace["extraction"] = extraction.model_dump()
            _persist_extraction(conn, report_id, extraction)
            _AUDIT.log_observation(
                PIPELINE_AGENT_ID,
                source=f"nlu_extract{'_cached' if cache_hit else ''}",
                data={
                    "report_id": report_id,
                    "incident_type": extraction.incident_type,
                    "severity": extraction.severity,
                    "casualties_mentioned": extraction.casualties_mentioned,
                    "confidence": extraction.confidence,
                    "transcript_excerpt": (transcript or "")[:120],
                },
            )
        finally:
            conn.close()

        # 3. Cluster + decide
        conn = _connect()
        try:
            cluster = find_cluster(conn, report_id)
            if cluster is None or cluster.n_reports < MIN_REPORTS_TO_DECLARE:
                # Below cluster threshold. Before giving up, check whether
                # this report sits near an already-declared incident of the
                # same type — if so, attach it instead of leaving it
                # floating. Otherwise every report that arrives AFTER a
                # declare ends up orphaned (its same-type neighbors are all
                # already stamped, so the cluster can't grow).
                attached_to = _attach_to_existing_incident(conn, report_id, extraction.incident_type)
                if attached_to is not None:
                    trace["stage"] = "attached_to_existing"
                    trace["declared_incident_id"] = attached_to
                    _AUDIT.log_observation(
                        PIPELINE_AGENT_ID,
                        source="attach",
                        data={
                            "report_id": report_id,
                            "attached_to": attached_to,
                            "incident_type": extraction.incident_type,
                        },
                    )
                    return trace
                trace["stage"] = "no_cluster"
                _AUDIT.log_observation(
                    PIPELINE_AGENT_ID,
                    source="cluster",
                    data={
                        "report_id": report_id,
                        "n_reports": cluster.n_reports if cluster else 0,
                        "verdict": "below declare threshold — waiting for more reports",
                    },
                )
                return trace

            declare = should_declare(cluster)
            incident_id: Optional[str] = None
            if declare is not None:
                _AUDIT.log_decision(
                    PIPELINE_AGENT_ID,
                    context=(
                        f"Cluster of {cluster.n_reports} {declare.incident_type} reports "
                        f"within {cluster.radius_m:.0f}m / {cluster.time_span_seconds:.0f}s"
                    ),
                    decision=f"declare_incident({declare.incident_type}, severity={declare.severity})",
                    rationale=(
                        f"derived_confidence={declare.derived_confidence:.2f}, "
                        f"casualties={cluster.any_casualties}"
                    ),
                )
                incident_id = _execute_declare(conn, declare)
                trace["declared_incident_id"] = incident_id
                _metric_inc("pipeline.incident_declared")
                _metric_inc(f"pipeline.declared.{declare.incident_type}")
                _AUDIT.log_tool_call(
                    PIPELINE_AGENT_ID,
                    tool_name="declare_incident",
                    arguments={
                        "incident_type": declare.incident_type,
                        "severity": declare.severity,
                        "severity_int": declare.severity_int,
                        "centroid": {"lat": declare.centroid_lat, "lng": declare.centroid_lng},
                        "n_reports": declare.n_reports,
                    },
                    result={"incident_id": incident_id},
                )

            if incident_id is None:
                trace["stage"] = "no_action"
                return trace
        finally:
            conn.close()

        # 4. Plan + execute response orders
        conn = _connect()
        try:
            world = slice_for_incident(conn, incident_id)
            if world is None:
                trace["stage"] = "no_world_slice"
                _AUDIT.log_recovery_action(
                    PIPELINE_AGENT_ID,
                    f"process_report({report_id}): no world slice for {incident_id}",
                    "skip plan — incident missing coords or row",
                )
                return trace
            plan = plan_response(world, place=extraction.location_hint or None)
            trace["plan"] = _plan_to_jsonable(plan)
            _AUDIT.log_decision(
                PIPELINE_AGENT_ID,
                context=f"Plan response for incident {incident_id}",
                decision=(
                    f"dispatch={sum(d.count for d in plan.dispatches)} trucks, "
                    f"cordon={'yes' if plan.cordon else 'no'}, "
                    f"alert={plan.alert.severity if plan.alert else 'none'}"
                ),
                rationale=plan.rationale,
            )
            executed = _execute_plan(conn, plan)
            trace["executed"] = executed
            if executed.get("dispatches"):
                _metric_inc("pipeline.dispatch_executed")
            if executed.get("cordon_id"):
                _metric_inc("pipeline.cordon_created")
            if executed.get("alert_id"):
                _metric_inc("pipeline.alert_published")
            for dispatch in executed.get("dispatches", []):
                _AUDIT.log_tool_call(
                    PIPELINE_AGENT_ID,
                    tool_name="dispatch_units",
                    arguments={"incident_id": incident_id, **dispatch},
                    result={"dispatch_id": dispatch.get("dispatch_id")},
                )
            if executed.get("cordon_id"):
                _AUDIT.log_tool_call(
                    PIPELINE_AGENT_ID,
                    tool_name="create_cordon",
                    arguments={"incident_id": incident_id, "radius_m": plan.cordon.radius_m},
                    result={"cordon_id": executed["cordon_id"]},
                )
            if executed.get("alert_id"):
                _AUDIT.log_tool_call(
                    PIPELINE_AGENT_ID,
                    tool_name="publish_citizen_alert",
                    arguments={
                        "incident_id": incident_id,
                        "severity": plan.alert.severity,
                        "message": plan.alert.message,
                    },
                    result={"alert_id": executed["alert_id"]},
                )
            trace["stage"] = "done"
            return trace
        finally:
            conn.close()
    except Exception as exc:
        # Last-line catch so a pipeline bug never bubbles out of the
        # BackgroundTask and gets swallowed by Starlette.
        logger.error(f"process_report({report_id}) failed: {exc}", exc_info=True)
        _AUDIT.log_recovery_action(
            PIPELINE_AGENT_ID,
            f"process_report({report_id}) crashed: {type(exc).__name__}: {exc}",
            "skip — pipeline error, will retry on next report",
        )
        trace["stage"] = "error"
        trace["error"] = f"{type(exc).__name__}: {exc}"
        return trace


# ── DB plumbing ─────────────────────────────────────────────────────────


def _connect():
    return psycopg2.connect(DATABASE_URL)


def _load_report(conn, report_id: str) -> Optional[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                id,
                transcript,
                (location->>'lat')::double precision AS lat,
                (location->>'lng')::double precision AS lng,
                declared_incident_id,
                nlu_extraction
            FROM citizen_reports
            WHERE id = %s;
            """,
            (report_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "transcript": row[1] or "",
        "lat": row[2],
        "lng": row[3],
        "declared_incident_id": row[4],
        "nlu_extraction": row[5],
    }


def _ensure_geom(conn, report_id: str, lat: float, lng: float) -> None:
    """Idempotent backfill of geom for one row."""
    lng_v, lat_v = to_geom_params(lat, lng)
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE citizen_reports SET geom = {to_geom_sql()} "
                f"WHERE id = %s AND geom IS NULL;",
                (lng_v, lat_v, report_id),
            )


def _cache_lookup(conn, transcript: str) -> Optional[ReportExtraction]:
    h = transcript_hash(transcript)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT extraction FROM nlu_cache "
            "WHERE transcript_hash = %s AND model_version = %s;",
            (h, model_version()),
        )
        row = cur.fetchone()
    if row is None:
        return None
    try:
        return ReportExtraction.model_validate(row[0])
    except Exception as exc:
        logger.warning(f"nlu_cache row failed Pydantic validation: {exc}")
        return None


def _cache_store(conn, transcript: str, extraction: ReportExtraction) -> None:
    h = transcript_hash(transcript)
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO nlu_cache (transcript_hash, model_version, extraction)
                VALUES (%s, %s, %s)
                ON CONFLICT (transcript_hash) DO UPDATE
                  SET extraction = EXCLUDED.extraction,
                      model_version = EXCLUDED.model_version,
                      created_at = NOW();
                """,
                (h, model_version(), json.dumps(extraction.model_dump())),
            )


def _persist_extraction(conn, report_id: str, extraction: ReportExtraction) -> None:
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE citizen_reports SET nlu_extraction = %s WHERE id = %s;",
                (json.dumps(extraction.model_dump()), report_id),
            )


def _attach_to_existing_incident(conn, report_id: str, incident_type: str) -> Optional[str]:
    """If this report sits near an active same-type incident, attach it
    (stamp declared_incident_id) and return that incident's id. Otherwise None.

    Closes the "orphaned reports" gap: once a declare stamps its cluster
    members, subsequent reports for the same physical incident find no
    unstamped neighbors and can't re-cluster. Without this fallback they'd
    sit forever as floating observations.
    """
    from pipeline.cluster import ATTACH_TO_EXISTING_RADIUS_M

    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id
                FROM disaster_events d, citizen_reports r
                WHERE r.id = %s
                  AND r.geom IS NOT NULL
                  AND d.status = 'active'
                  AND d.disaster_type = %s
                  AND ST_DistanceSphere(
                          ST_SetSRID(ST_MakePoint(
                              COALESCE(
                                  (d.location_estimate->>'lng')::double precision,
                                  ST_X(ST_Centroid(
                                      CASE
                                          WHEN pg_typeof(d.area_geometry) = 'jsonb'::regtype
                                            THEN ST_GeomFromGeoJSON(d.area_geometry::text)
                                          ELSE d.area_geometry
                                      END
                                  )::geometry)
                              ),
                              COALESCE(
                                  (d.location_estimate->>'lat')::double precision,
                                  ST_Y(ST_Centroid(
                                      CASE
                                          WHEN pg_typeof(d.area_geometry) = 'jsonb'::regtype
                                            THEN ST_GeomFromGeoJSON(d.area_geometry::text)
                                          ELSE d.area_geometry
                                      END
                                  )::geometry)
                              )
                          ), 4326),
                          r.geom::geometry
                      ) <= %s
                ORDER BY d.created_at DESC
                LIMIT 1;
                """,
                (report_id, incident_type, ATTACH_TO_EXISTING_RADIUS_M),
            )
            row = cur.fetchone()
            if row is None:
                return None
            incident_id = str(row[0])
            cur.execute(
                "UPDATE citizen_reports SET declared_incident_id = %s::uuid WHERE id = %s::uuid;",
                (incident_id, report_id),
            )
    return incident_id


# ── Declare (advisory-lock dedup) ───────────────────────────────────────


def _execute_declare(conn, declare: DeclareIncident) -> Optional[str]:
    """Insert a new disaster_events row with deterministic dedup.

    Uses ``pg_advisory_xact_lock`` keyed on a hash of
    ``(incident_type, geohash_5)`` so two concurrent workers that both
    chose to declare can't both insert. After acquiring the lock, the
    second worker re-queries and finds the first one's row, returning
    its id.

    Also stamps the member citizen_reports.declared_incident_id so the
    cluster query won't pull them in next time.
    """
    # Last-line policy check before opening any transaction.
    v = _policy.validate_declare(
        incident_type=declare.incident_type,
        severity=declare.severity,
        n_reports=declare.n_reports,
        derived_confidence=declare.derived_confidence,
    )
    if not v.approved:
        logger.warning(f"_execute_declare: policy DENIED ({v.reason}); skipping")
        return None

    # Geohash-5 of the centroid is ~5km² — coarse enough to dedup nearby
    # candidates, fine enough not to merge unrelated districts.
    gh = _geohash(declare.centroid_lat, declare.centroid_lng, precision=5)
    lock_key = _advisory_key(f"declare:{declare.incident_type}:{gh}")

    new_id = str(uuid.uuid4())
    declared_id: Optional[str] = None

    with conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(%s);", (lock_key,))

            # Re-check inside the lock: is there already a recent same-type
            # incident within 800m? If so, return its id and stamp our reports
            # to it.
            #
            # Coordinate resolution mirrors world_slice.py: prefer
            # location_estimate (AI-set), fall back to area_geometry centroid
            # (operator-set, may be PostGIS geometry OR JSONB GeoJSON).
            cur.execute(
                """
                SELECT id
                FROM disaster_events
                WHERE status = 'active'
                  AND disaster_type = %s
                  AND ST_DistanceSphere(
                          ST_SetSRID(ST_MakePoint(
                              COALESCE(
                                  (location_estimate->>'lng')::double precision,
                                  ST_X(ST_Centroid(
                                      CASE
                                          WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                                            THEN ST_GeomFromGeoJSON(area_geometry::text)
                                          ELSE area_geometry
                                      END
                                  )::geometry)
                              ),
                              COALESCE(
                                  (location_estimate->>'lat')::double precision,
                                  ST_Y(ST_Centroid(
                                      CASE
                                          WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                                            THEN ST_GeomFromGeoJSON(area_geometry::text)
                                          ELSE area_geometry
                                      END
                                  )::geometry)
                              )
                          ), 4326),
                          ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                      ) <= 800
                ORDER BY created_at DESC
                LIMIT 1;
                """,
                (declare.incident_type, declare.centroid_lng, declare.centroid_lat),
            )
            existing = cur.fetchone()
            if existing is not None:
                declared_id = str(existing[0])
                logger.info(
                    f"_execute_declare: existing {declare.incident_type} at {gh} "
                    f"({declared_id}); attaching reports"
                )
            else:
                # area_geometry MUST be set so the frontend engine's
                # eventCenter() can find this zone's center; without it,
                # trucks spawn but can't engage and the wave never resolves.
                #
                # Important: the deployed Supabase has area_geometry as a
                # PostGIS `geometry` column, not JSONB (despite init.sql
                # declaring JSONB — Supabase rewrote it for spatial
                # indexing). So we MUST cast through ST_GeomFromGeoJSON.
                # _row_to_disaster in main.py wraps reads in ST_AsGeoJSON
                # so the frontend still sees JSON.
                point_geojson = json.dumps({
                    "type": "Point",
                    "coordinates": [declare.centroid_lng, declare.centroid_lat],
                })
                cur.execute(
                    """
                    INSERT INTO disaster_events
                        (id, disaster_type, severity, status, notes,
                         location_estimate, area_geometry, geometry_kind)
                    VALUES (
                        %s, %s, %s, 'active', %s, %s::jsonb,
                        ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                        'point'
                    );
                    """,
                    (
                        new_id,
                        declare.incident_type,
                        declare.severity_int,
                        declare.notes,
                        json.dumps({"lat": declare.centroid_lat, "lng": declare.centroid_lng}),
                        point_geojson,
                    ),
                )
                declared_id = new_id

            # Stamp every member report so they don't re-cluster.
            # citizen_reports.id is UUID; explicit cast is required because
            # psycopg2 sends the Python list of strings as text[] and
            # Postgres won't auto-cast uuid = text.
            cur.execute(
                """
                UPDATE citizen_reports
                SET declared_incident_id = %s::uuid
                WHERE id = ANY(%s::uuid[]);
                """,
                (declared_id, declare.member_report_ids),
            )

    return declared_id


# ── Plan execution (dispatch row lock, cordon, alert) ───────────────────


def _execute_plan(conn, plan: ResponsePlan) -> Dict[str, Any]:
    executed = {
        "dispatches": [],
        "cordon_id": None,
        "alert_id": None,
        "denials": [],
    }
    for order in plan.dispatches:
        result = _execute_dispatch_locked(conn, plan.incident_id, order)
        if result is not None:
            executed["dispatches"].append(result)
    if plan.cordon is not None:
        cordon_id = _execute_cordon(conn, plan.cordon)
        executed["cordon_id"] = cordon_id
    if plan.alert is not None:
        alert_id = _execute_alert(conn, plan.alert)
        executed["alert_id"] = alert_id
    return executed


def _execute_dispatch_locked(
    conn, incident_id: str, order: DispatchOrder
) -> Optional[Dict[str, Any]]:
    """Row-locked fire-truck dispatch.

    Critical-section flow:
      1. BEGIN
      2. SELECT ... FOR UPDATE on fire_stations.id = order.station_id
      3. Read FRESH (truck_count - trucks_dispatched) = available
      4. Run policy.validate_dispatch against fresh `available`
      5. If approved: UPDATE fire_stations SET trucks_dispatched += count
                       INSERT INTO active_dispatches
      6. COMMIT
    """
    # Pull the incident's severity for the policy check.
    with conn.cursor() as cur:
        cur.execute(
            "SELECT severity FROM disaster_events WHERE id = %s;", (incident_id,)
        )
        row = cur.fetchone()
    if row is None:
        return None
    from pipeline.decide import severity_int_to_str
    severity_str = severity_int_to_str(int(row[0]))

    with conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, lat, lng, truck_count, trucks_dispatched "
                "FROM fire_stations WHERE id = %s FOR UPDATE;",
                (order.station_id,),
            )
            srow = cur.fetchone()
            if srow is None:
                logger.warning(f"dispatch: station {order.station_id} not found")
                return None
            _id, lat, lng, total, dispatched = srow
            available = int(total) - int(dispatched)

            # Validate against FRESH availability — this is what the row lock buys us.
            v = _policy.validate_dispatch(
                count=order.count,
                severity=severity_str,
                station_available=available,
            )
            if not v.approved:
                logger.info(
                    f"dispatch: policy denied for {order.station_id}: {v.reason}"
                )
                return None

            # Bump dispatched counter
            cur.execute(
                "UPDATE fire_stations SET trucks_dispatched = trucks_dispatched + %s "
                "WHERE id = %s;",
                (order.count, order.station_id),
            )

            # Fetch the incident centroid so we can both INSERT into
            # active_dispatches AND push to the frontend's in-process queue.
            cur.execute(
                """
                SELECT
                    COALESCE(
                        (location_estimate->>'lat')::double precision,
                        ST_Y(ST_Centroid(
                            CASE
                                WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                                    THEN ST_GeomFromGeoJSON(area_geometry::text)
                                ELSE area_geometry
                            END
                        )::geometry)
                    ),
                    COALESCE(
                        (location_estimate->>'lng')::double precision,
                        ST_X(ST_Centroid(
                            CASE
                                WHEN pg_typeof(area_geometry) = 'jsonb'::regtype
                                    THEN ST_GeomFromGeoJSON(area_geometry::text)
                                ELSE area_geometry
                            END
                        )::geometry)
                    )
                FROM disaster_events WHERE id = %s;
                """,
                (incident_id,),
            )
            target_row = cur.fetchone()
            if target_row is None or target_row[0] is None or target_row[1] is None:
                logger.warning(
                    f"dispatch: incident {incident_id} has no resolvable coords; skipping"
                )
                return None
            target_lat, target_lng = float(target_row[0]), float(target_row[1])

            # Record the dispatch row (used by /api/warnings/nearby + mobile).
            dispatch_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO active_dispatches
                    (id, event_id, service_type, target_lat, target_lng, radius_m,
                     unit_count, status, source)
                VALUES (%s, %s, 'fire', %s, %s, 1500, %s, 'active', 'ai');
                """,
                (dispatch_id, incident_id, target_lat, target_lng, order.count),
            )

    # Push to the frontend's in-process truck-animation queue. The DB row
    # above is what mobile clients see via /api/warnings/nearby; this push
    # is what makes a truck visually drive from the station to the incident
    # on the operator dashboard. Both must fire for the dispatch to be "real".
    try:
        from main import _enqueue_pending_dispatch  # lazy: avoid circular import
        _enqueue_pending_dispatch(
            kind="firefighter",
            units=order.count,
            target={"lat": target_lat, "lng": target_lng},
            station_id=order.station_id,
        )
    except Exception as exc:
        logger.warning(
            f"dispatch: in-process queue push failed (truck won't animate): {exc}"
        )

    return {
        "dispatch_id": dispatch_id,
        "station_id": order.station_id,
        "count": order.count,
    }


def _execute_cordon(conn, cordon) -> Optional[str]:
    """Insert a cordon row. Geometry is a JSONB circle approximation.

    Idempotency: short-circuit if any active cordon already exists at this
    centroid (within 100m). Concurrency is low here so a simple check
    suffices.
    """
    v = _policy.validate_cordon(radius_m=cordon.radius_m)
    if not v.approved:
        logger.info(f"cordon: policy denied: {v.reason}")
        return None
    cid = str(uuid.uuid4())
    # GeoJSON circle approximation (40-sided polygon via PostGIS ST_Buffer).
    # Stamp event_id so DELETE /api/disasters/{id} can sweep the cordon
    # closed when the incident is resolved.
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cordons (id, geometry, reason, status, event_id)
                SELECT
                    %s,
                    ST_AsGeoJSON(ST_Buffer(
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                        %s
                    )::geometry)::jsonb,
                    %s,
                    'active',
                    %s::uuid;
                """,
                (cid, cordon.centroid_lng, cordon.centroid_lat,
                 cordon.radius_m, cordon.reason, cordon.incident_id),
            )
    return cid


def _execute_alert(conn, alert) -> Optional[str]:
    v = _policy.validate_alert(severity=alert.severity, message=alert.message)
    if not v.approved:
        logger.info(f"alert: policy denied: {v.reason}")
        return None
    aid = str(uuid.uuid4())
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO notifications (id, geometry, reason, status)
                VALUES (%s, %s::jsonb, %s, 'active');
                """,
                (aid, json.dumps({"type": "Alert", "severity": alert.severity}), alert.message),
            )
    return aid


# ── Helpers ─────────────────────────────────────────────────────────────


def _plan_to_jsonable(plan: ResponsePlan) -> Dict[str, Any]:
    return {
        "incident_id": plan.incident_id,
        "rationale": plan.rationale,
        "dispatches": [
            {"station_id": d.station_id, "station_name": d.station_name,
             "unit_type": d.unit_type, "count": d.count}
            for d in plan.dispatches
        ],
        "cordon": (
            {"radius_m": plan.cordon.radius_m, "reason": plan.cordon.reason,
             "lat": plan.cordon.centroid_lat, "lng": plan.cordon.centroid_lng}
            if plan.cordon else None
        ),
        "alert": (
            {"severity": plan.alert.severity, "message": plan.alert.message}
            if plan.alert else None
        ),
    }


def _advisory_key(name: str) -> int:
    """Map a string to a 32-bit signed int for pg_advisory_xact_lock(int)."""
    h = hashlib.sha256(name.encode("utf-8")).digest()
    n = int.from_bytes(h[:4], "big", signed=False)
    # Postgres advisory_lock takes int8 but the int4 overload is fine; clamp to int4 range.
    return n & 0x7FFFFFFF


def _geohash(lat: float, lng: float, *, precision: int = 5) -> str:
    """Tiny geohash implementation — no external dependency."""
    base32 = "0123456789bcdefghjkmnpqrstuvwxyz"
    lat_range = [-90.0, 90.0]
    lng_range = [-180.0, 180.0]
    geohash = []
    bits = 0
    bit = 0
    even = True
    while len(geohash) < precision:
        if even:
            mid = (lng_range[0] + lng_range[1]) / 2.0
            if lng >= mid:
                bits = (bits << 1) | 1
                lng_range[0] = mid
            else:
                bits <<= 1
                lng_range[1] = mid
        else:
            mid = (lat_range[0] + lat_range[1]) / 2.0
            if lat >= mid:
                bits = (bits << 1) | 1
                lat_range[0] = mid
            else:
                bits <<= 1
                lat_range[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            geohash.append(base32[bits])
            bits = 0
            bit = 0
    return "".join(geohash)
