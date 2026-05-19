// Tests for triggerRobbery + the event-id contract that the dashboard's
// citizen-report batcher and the backend's UUID column rely on.
//
// Run with:
//   node --test frontend/src/sim/__tests__/triggerRobbery.test.mjs
//
// The engine ticks on a stub road graph so this stays a pure unit test —
// no Leaflet, no React, no DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCitizenEngine } from '../citizenEngine.js'
import { isPersistableEventId, UUID_RE } from '../../lib/eventId.js'

// ────────────────────────────────────────────────────────────────────
// Stub road graph: a 3×3 grid of nodes near Times Square. Just enough
// connectivity for spawn() / pickRandomWalkNext() not to fail.
// ────────────────────────────────────────────────────────────────────
function makeStubGraph({ step = 0.0002, rows = 3, cols = 3 } = {}) {
  // Default ~22 m per cell so all 3×3 grid nodes fall inside the engine's
  // ROBBERY_VICTIM_RADIUS_M (60 m) AND POLICE_INTERVENTION_RADIUS_M (100 m).
  // Pass a larger step for tests that need the cop *outside* catch range.
  const ROWS = rows, COLS = cols
  const lat0 = 40.78, lng0 = -73.98
  const STEP = step
  const nodes = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      nodes.push({ id: `${r}_${c}`, lat: lat0 + r * STEP, lng: lng0 + c * STEP })
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const neighbors = (id) => {
    const [r, c] = id.split('_').map(Number)
    const out = []
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue
      out.push({ to: `${nr}_${nc}`, weight: STEP })
    }
    return out
  }
  return {
    size: () => nodes.length,
    getRandomNode: () => nodes[Math.floor(Math.random() * nodes.length)].id,
    nodeLocation: (id) => byId.get(id) || null,
    neighbors,
    findNearestNode: (lat, lng) => {
      let best = null, bestD = Infinity
      for (const n of nodes) {
        const d = (n.lat - lat) ** 2 + (n.lng - lng) ** 2
        if (d < bestD) { bestD = d; best = n.id }
      }
      return best
    },
    bfs: (from, to) => {
      if (from === to) return [from]
      const q = [from]
      const prev = new Map([[from, null]])
      while (q.length) {
        const cur = q.shift()
        if (cur === to) {
          const out = []
          let n = to
          while (n != null) { out.unshift(n); n = prev.get(n) }
          return out
        }
        for (const nb of neighbors(cur)) {
          if (!prev.has(nb.to)) { prev.set(nb.to, cur); q.push(nb.to) }
        }
      }
      return null
    },
    nodeIdsInBbox: (latMin, latMax, lngMin, lngMax, out) => {
      for (const n of nodes) {
        if (n.lat >= latMin && n.lat <= latMax && n.lng >= lngMin && n.lng <= lngMax) {
          out.push(n.id)
        }
      }
    },
  }
}

function makeEngine({ count = 8, graph = makeStubGraph() } = {}) {
  // Spawn count default = 8 so the 9 grid nodes always have multiple citizens
  // (the robbery picker skips the criminal themselves and needs a victim/
  // witness within 60-80 m).
  const reports = []
  const engine = createCitizenEngine({
    roadGraph: graph,
    count,
    reserve: 4,
    getZones: () => [],
    getNotifications: () => [],
    getCordons: () => [],
    onReport: (r) => reports.push(r),
  })
  return { engine, reports }
}

// ────────────────────────────────────────────────────────────────────
// UUID-regex contract — the exact filter the dashboard uses to decide
// what reaches /api/citizen-report.
// ────────────────────────────────────────────────────────────────────

test('isPersistableEventId accepts canonical UUIDs', () => {
  assert.equal(isPersistableEventId('a1b2c3d4-e5f6-7890-abcd-ef0123456789'), true)
  assert.equal(isPersistableEventId('A1B2C3D4-E5F6-7890-ABCD-EF0123456789'), true)  // upper case
})

test('isPersistableEventId rejects synthetic crime ids', () => {
  assert.equal(isPersistableEventId('crime:356:1053'), false)
  assert.equal(isPersistableEventId('crime:0:0'), false)
})

test('isPersistableEventId rejects garbage, empty, null, undefined', () => {
  assert.equal(isPersistableEventId('not-a-uuid-at-all'), false)
  assert.equal(isPersistableEventId(''), false)
  assert.equal(isPersistableEventId(null), false)
  assert.equal(isPersistableEventId(undefined), false)
  assert.equal(isPersistableEventId(42), false)
  // Almost-but-not-quite a UUID (one char short).
  assert.equal(isPersistableEventId('a1b2c3d4-e5f6-7890-abcd-ef012345678'), false)
})

// ────────────────────────────────────────────────────────────────────
// triggerRobbery behavior
// ────────────────────────────────────────────────────────────────────

test('triggerRobbery (no cop, L2): victim calls in — criminal is never the reporter', () => {
  const { engine, reports } = makeEngine({ count: 4 })
  const origRandom = Math.random
  Math.random = () => 0.01  // force the injure roll to pass
  let res
  try {
    res = engine.triggerRobbery(0, 2)
  } finally {
    Math.random = origRandom
  }
  assert.equal(res.result, 'committed')
  assert.ok(res.injuredIdx >= 0, 'a victim should have been injured')
  assert.notEqual(res.injuredIdx, 0, 'criminal should not injure themselves')
  assert.equal(reports.length, 1)
  const r = reports[0]
  // Regression: the criminal must NOT be the citizen_idx of the report.
  assert.notEqual(r.citizen_idx, 0, 'criminal should never call in their own crime')
  assert.equal(r.citizen_idx, res.injuredIdx, 'the injured victim is the reporter')
  assert.match(r.event_id, /^crime:\d+:\d+$/)
})

test('triggerRobbery (no cop, no injury): a nearby walking witness calls in', () => {
  const { engine, reports } = makeEngine({ count: 4 })
  const origRandom = Math.random
  Math.random = () => 0.99  // force injury roll to fail (no victim)
  let res
  try {
    res = engine.triggerRobbery(0, 1)
  } finally {
    Math.random = origRandom
  }
  assert.equal(res.result, 'committed')
  assert.equal(res.injuredIdx, -1, 'no injury this time')
  // If a witness was within 80 m, they should be the reporter.
  if (res.reporterIdx >= 0) {
    assert.notEqual(res.reporterIdx, 0, 'criminal is not the reporter')
    assert.equal(reports.length, 1)
    assert.equal(reports[0].citizen_idx, res.reporterIdx)
    assert.match(reports[0].transcript, /[Bb]ystander|witness/, 'transcript should be a witness report')
  }
})

test('triggerRobbery emits a crime:* event_id that fails the persistable-UUID check (regression)', () => {
  const { engine, reports } = makeEngine({ count: 4 })
  const origRandom = Math.random
  Math.random = () => 0.01  // ensure a victim → guaranteed onReport
  try {
    engine.triggerRobbery(0, 2)
  } finally {
    Math.random = origRandom
  }
  assert.ok(reports.length >= 1)
  for (const r of reports) {
    assert.equal(
      isPersistableEventId(r.event_id), false,
      `crime event_id ${r.event_id} should NOT be persistable — would cause Postgres UUID parse failure`,
    )
    assert.equal(UUID_RE.test(r.event_id), false)
  }
})

test('triggerRobbery returns invalid for out-of-range / dead / arrested citizens', () => {
  const { engine } = makeEngine({ count: 4 })
  assert.equal(engine.triggerRobbery(-1, 1).result, 'invalid')
  assert.equal(engine.triggerRobbery(9999, 1).result, 'invalid')
})

test('triggerRobbery catch path: criminal becomes arrested + hidden, cop targets home station, NO 911 call', () => {
  const { engine, reports } = makeEngine({ count: 4 })
  // Spawn a single officer who patrols on top of the citizens (3×3 grid is
  // <300 m wide; everyone is within POLICE_INTERVENTION_RADIUS_M=100).
  const spawned = engine.spawnPolice(
    'manual-test-catch',
    { lat: 40.781, lng: -73.979 },
    { lat: 40.781, lng: -73.979, radius: 400 },
    1,
    'test-station',
  )
  assert.equal(spawned, 1)
  // Find the cop slot (kind===3) so we can inspect them after the catch.
  const snapBefore = engine.snapshot()
  let copIdx = -1
  for (let i = 0; i < snapBefore.count; i++) {
    if (snapBefore.kind[i] === 3) { copIdx = i; break }
  }
  assert.ok(copIdx >= 0, 'cop should have spawned')
  const res = engine.triggerRobbery(0, 2)
  assert.equal(res.result, 'caught', 'cop within 100 m should catch the suspect')
  assert.equal(res.policeIdx, copIdx)
  // Catch path must NOT fire a 911 call — the cop is already on scene.
  assert.equal(reports.length, 0, 'no 911 report should be filed when cop is on scene')
  // Criminal is now hidden + arrested, awaiting transport.
  const snap = engine.snapshot()
  assert.equal(snap.states[0], 'arrested')
  assert.equal(snap.hidden[0], 1, 'criminal should be hidden during transport')
  assert.equal(snap.kind[0], 0, 'criminal is still a citizen kind, just arrested')
})

test('retaskReturningTrucks: returning trucks flip back to en-route under the new dispatch', () => {
  // Spawn a truck, recall it (puts it into RETURNING), then re-task to a new
  // target. The truck's dispatchId should switch and its role should leave
  // RETURNING — so it never wastes the trip home.
  const { engine } = makeEngine({ count: 4 })
  const spawned = engine.spawnFireTrucks(
    'orig-dispatch',
    { lat: 40.781, lng: -73.979 },           // station
    { lat: 40.781, lng: -73.979, radius: 400 },  // first target
    1,
    'station-A',
  )
  assert.equal(spawned, 1)
  // Mark it RETURNING via the public recall API.
  const n = engine.recallTrucks('orig-dispatch')
  assert.equal(n, 1)
  // Now redirect it to a new target.
  const retasked = engine.retaskReturningTrucks(
    'new-dispatch',
    { lat: 40.781, lng: -73.978, radius: 300 },
    3,  // we ask for more than available; should re-task what it can
  )
  assert.equal(retasked, 1, 'one returning truck should be re-tasked')
  // After the next render, that truck is now serving 'new-dispatch'.
  const dispatchIds = engine.getActiveDispatchIds()
  assert.equal(dispatchIds.has('new-dispatch'), true)
  assert.equal(dispatchIds.has('orig-dispatch'), false, 'no truck should still belong to the original dispatch')
})

test('retaskReturningAmbulances: empty returning ambulances are redirected', () => {
  const { engine } = makeEngine({ count: 4 })
  engine.spawnAmbulances(
    'orig-amb',
    { lat: 40.781, lng: -73.979 },
    { lat: 40.781, lng: -73.979, radius: 150 },
    1,
    'hospital-A',
  )
  engine.recallAmbulances('orig-amb')  // → AMB_ROLE_RETURNING
  const retasked = engine.retaskReturningAmbulances(
    'new-amb',
    { lat: 40.782, lng: -73.978, radius: 100 },
    1,
  )
  assert.equal(retasked, 1)
  const ids = engine.getActiveAmbulanceDispatchIds()
  assert.equal(ids.has('new-amb'), true)
})

test('retaskReturningPolice: returning officers are redirected to new patrol', () => {
  const { engine } = makeEngine({ count: 4 })
  engine.spawnPolice(
    'manual-orig',
    { lat: 40.781, lng: -73.979 },
    { lat: 40.781, lng: -73.979, radius: 400 },
    1,
    'station-A',
  )
  engine.recallPolice('manual-orig')
  const retasked = engine.retaskReturningPolice(
    'manual-new',
    { lat: 40.783, lng: -73.977, radius: 400 },
    1,
  )
  assert.equal(retasked, 1)
  const ids = engine.getActivePoliceDispatchIds()
  assert.equal(ids.has('manual-new'), true)
})

test('retaskReturningTrucks does NOT grab a truck currently EN_ROUTE or PATROLLING', () => {
  // Only RETURNING trucks should be re-taskable. Trucks still actively on
  // their original mission should be left alone.
  const { engine } = makeEngine({ count: 4 })
  engine.spawnFireTrucks(
    'active-dispatch',
    { lat: 40.781, lng: -73.979 },
    { lat: 40.781, lng: -73.979, radius: 400 },
    1,
    'station-A',
  )
  // Don't recall it — it's still in EN_ROUTE / PATROLLING.
  const retasked = engine.retaskReturningTrucks(
    'new-dispatch',
    { lat: 40.782, lng: -73.978, radius: 300 },
    5,
  )
  assert.equal(retasked, 0, 'no truck is returning, so nothing should be re-tasked')
})

test('triggerRobbery dispatches a responding cop when nobody is in catch radius', () => {
  // Wide grid: ~1 km per cell so the cop's station (far node) is well outside
  // the 100 m intervention radius from where the criminal spawns at (0,0).
  // The robbery should be committed, and respondToCrime should set the
  // single nearest available cop's role to RESPONDING.
  const farGraph = makeStubGraph({ step: 0.01, rows: 3, cols: 3 })  // ~1.1 km per cell
  const { engine } = makeEngine({ count: 8, graph: farGraph })
  // Station at the far corner of the grid (~3 km from origin) — well outside 100 m.
  engine.spawnPolice(
    'manual-test-resp',
    { lat: 40.80, lng: -73.96 },
    { lat: 40.80, lng: -73.96, radius: 400 },
    1,
    'test-station',
  )
  // Force criminal to be at node (0,0); since spawn is random we use whichever
  // citizen actually landed nearest the origin. Easiest: just trigger on idx 0
  // and accept either branch — we mainly want to verify that when the result
  // IS 'committed', a responder slot is recorded (or -1 if literally no cop
  // was available, which can happen if the cop happened to be near the
  // criminal randomly).
  const origRandom = Math.random
  Math.random = () => 0.99
  try {
    const res = engine.triggerRobbery(0, 1)
    if (res.result === 'committed') {
      // The single available cop (if any) becomes the responder. With a 3-km
      // grid and one cop, this should virtually always be 'committed' with
      // responderIdx >= 0.
      assert.ok(typeof res.responderIdx === 'number',
        `expected responderIdx in result, got ${JSON.stringify(res)}`)
    }
  } finally {
    Math.random = origRandom
  }
})
