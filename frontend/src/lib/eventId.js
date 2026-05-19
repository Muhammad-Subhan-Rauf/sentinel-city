// Shared helpers for the event-id contract between the citizen engine, the
// dashboard's report-flush batcher, and the backend's citizen_reports table.
//
// Real disaster events carry a Postgres UUID (`disaster_events.id`). The
// engine also emits synthetic ids for operator-triggered crimes (e.g.
// `crime:539:797`) so the call drawer can show them — but those must NOT
// reach the DB, which rejects anything that isn't a valid UUID.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isPersistableEventId(id) {
  return typeof id === 'string' && UUID_RE.test(id)
}
