// Citizen simulation: pure JS, no React.
//
// Citizens walk on a road graph. Each tick:
//   1. Advance position along their current edge.
//   2. On reaching the target node, pick a new random destination.
//   3. Walking citizens scan nearby events. If inside a perception radius
//      → emit an 'observation' report and switch to behavior state (flee/hide/etc).
//   4. Citizens inside an area-type 'affected' event roll a per-tick chance to
//      become 'affected' (heat exhaustion, power-outage distress).
//
// State machine: walking | fleeing | approaching | hiding | affected | shelter
//
// Physics tick at 1 Hz. The CitizenLayer paints via requestAnimationFrame and
// interpolates positions for smoothness.

import { SpatialIndex } from './spatialIndex.js'
import { getProfile, getPerception } from '../lib/disasterProfiles.js'
import {
  FIRE_TRUCK_CAPACITY,
  EXTINGUISH_RATE_PER_FF_M_PER_S,
  BUILDING_EXTINGUISH_RATE,
  TRUCK_EXTINGUISH_REACH_M,
  TRUCK_PATROL_RADIUS_M,
} from '../lib/config.js'

// Speeds are "demo-tuned" — faster than realistic pedestrian speeds so motion
// is visible at typical map zoom levels. Real walking is ~1.4 m/s but that's
// sub-pixel at zoom 14, making citizens appear frozen.
const SPEED_MPS = {
  walking: 4.0,      // ~14 km/h — fast enough to read as motion even at zoom 14
  fleeing: 7.0,      // panic sprint, clearly faster than walking
  approaching: 4.0,
  hiding: 0.0,
  affected: 0.0,
  fainted: 0.0,      // collapsed on the ground
  shelter: 1.5,      // slow shuffle to shade
  // Fire-truck pseudo-states. State string is reused for SPEED_MPS lookup; the
  // truck's actual behaviour is driven by truckRole, not by `states[idx]`.
  truck_driving: 20.0,
  truck_patrolling: 9.0,
  truck_extinguishing: 0.0,
}

// How long (sim seconds) a citizen stays in a reactive state before returning
// to walking. `affected` and `fainted` are sticky until either a natural timer
// elapses OR the causing zone is removed (handled by the recovery logic).
// fleeing > REPORT_COOLDOWN_S so citizens don't briefly walk back toward the
// threat in the gap between flee-state expiry and the next observation report.
const STATE_DURATION_S = {
  fleeing: 45,
  approaching: 35,
  hiding: 20,
  shelter: 60,
  affected: Infinity,
  fainted: Infinity,
}

// Range within which a walking citizen will notice an unconscious person and
// call 911 on their behalf.
const WITNESS_PERCEPTION_M = 50

// Per-citizen-per-event report cooldown so a citizen oscillating at a
// perception boundary doesn't spam the call stream.
const REPORT_COOLDOWN_S = 30

const EARTH_R = 6378137

function distanceMeters(latA, lngA, latB, lngB) {
  const dLat = ((latB - latA) * Math.PI) / 180
  const dLng = ((lngB - lngA) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((latA * Math.PI) / 180) *
      Math.cos((latB * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(a))
}

function pointInPolygonRing(lng, lat, ring) {
  // Ray-cast point-in-polygon for a single ring of [lng,lat] pairs.
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function eventCenter(zone) {
  if (zone?.geometryKind === 'city') {
    // Citywide events have no center; signal "everywhere" with a null sentinel
    // so the spatial index falls through to a different path.
    return null
  }
  if (!zone?.geometry) return null
  if (zone.geometry.type === 'Point') {
    const [lng, lat] = zone.geometry.coordinates
    return { lat, lng }
  }
  if (zone.geometry.type === 'Polygon') {
    // Centroid of the first ring — good enough for a fleeing direction reference.
    const ring = zone.geometry.coordinates[0]
    let sx = 0, sy = 0
    for (const [lng, lat] of ring) { sx += lng; sy += lat }
    return { lat: sy / ring.length, lng: sx / ring.length }
  }
  return null
}

function isCitizenInsideZone(lat, lng, zone) {
  if (zone?.geometryKind === 'city') return true // city-wide: everyone is inside
  if (!zone?.geometry) return false
  if (zone.geometry.type === 'Point') {
    const r = zone.geometry.radius_metres
    if (!r) return false
    const [zlng, zlat] = zone.geometry.coordinates
    return distanceMeters(lat, lng, zlat, zlng) <= r
  }
  if (zone.geometry.type === 'Polygon') {
    return pointInPolygonRing(lng, lat, zone.geometry.coordinates[0])
  }
  return false
}

// Max distance from a polygon centroid to any of its vertices. Used as the
// upper bound for the spreading-hazard wave radius so the wave eventually
// covers the entire drawn polygon.
function maxRadiusFromCentroid(geometry, centroid) {
  if (!geometry) return 0
  if (geometry.type === 'Point') return geometry.radius_metres || 0
  if (geometry.type === 'Polygon') {
    let m = 0
    for (const [lng, lat] of geometry.coordinates[0]) {
      const dLat = ((lat - centroid.lat) * Math.PI) / 180
      const dLng = ((lng - centroid.lng) * Math.PI) / 180
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((centroid.lat * Math.PI) / 180) *
          Math.cos((lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2
      const d = 2 * EARTH_R * Math.asin(Math.sqrt(a))
      if (d > m) m = d
    }
    return m
  }
  return 0
}

export function createCitizenEngine({
  roadGraph,
  count = 400,
  // Extra pre-allocated slots beyond the initial `count`, used by
  // spawnFleeingCitizens (Building_Fire escapees) at runtime. Typed arrays
  // can't grow, so we reserve capacity up front. Negligible memory cost.
  reserve = 1000,
  getZones,
  // Optional: provide active operator-issued notifications (evacuation alerts)
  // and cordons (no-entry zones). Both expected to return arrays of
  // { id, geometry, reason }. The engine treats notifications as flee triggers
  // for citizens inside them, and cordons as soft no-go zones (citizens stop
  // at the boundary; trucks ignore them).
  getNotifications,
  getCordons,
  onReport,
  // Engine → app callbacks. onZoneResolved fires when extinguishing brings a
  // fire's intensity / wave radius to zero. onScheduledSpread fires when a
  // Building Fire's delayed-spread timer elapses and its (still-draft)
  // children should be activated by the app.
  onZoneResolved,
  onScheduledSpread,
}) {
  // Capacity of every parallel array. Slots [count..capacity-1] start unused
  // and become live when spawnFleeingCitizens fills them. Slots also become
  // free again when Building_Fire evacuees despawn (see `alive` / `liveCount`).
  const capacity = count + reserve
  // High-water mark for the hot loops: 0..activeCount has at least once been a
  // valid slot. We don't shrink activeCount on despawn — `alive[i] = 0` marks
  // the gap and spawnFleeingCitizens reuses it before extending the watermark.
  let activeCount = count
  // Number of *currently alive* citizens. Drives snapshot.count + the dashboard
  // pill. Incremented on spawn, decremented on despawn.
  let liveCount = count

  // Per-citizen state, parallel arrays for hot loop access.
  const lats = new Float32Array(capacity)
  const lngs = new Float32Array(capacity)
  const currentNode = new Array(capacity)
  const targetNode = new Array(capacity)
  const path = new Array(capacity)          // remaining node sequence
  const states = new Array(capacity)
  const stateExpiresAt = new Float32Array(capacity)
  // The zone id that put a citizen into their current reactive state.
  // Used to detect when the originating disaster is removed so we can
  // gradually return citizens to normal walking.
  const causeZoneId = new Array(capacity).fill(null)
  // simTimeS at which an orphaned reactive citizen returns to walking.
  // 0 = not in recovery yet.
  const recoveryAt = new Float32Array(capacity)
  // Last node the citizen passed through. Used by the random-walk picker so
  // calm walkers don't immediately reverse direction at every intersection.
  const prevNode = new Array(capacity).fill(null)
  // Nodes that fall inside an active area hazard. Rebuilt each tick from the
  // current zone list. Walking citizens refuse to step onto these so they
  // don't wander back into a wildfire / flood polygon after their flee state
  // has expired. Re-entering would re-trigger fleeing, producing the
  // oscillating "leave then come back and hit the area" behaviour.
  const hazardNodeSet = new Set()
  // Map<eventId, lastReportT_seconds> per citizen
  const reportLog = Array.from({ length: capacity }, () => new Map())
  // Per-zone time-based state for hazards with `spreads: true`. Populated
  // lazily the first time we see a zone; pruned when the zone disappears.
  //   zoneId → { startTime, centroid: { lat, lng }, maxRadius, spreadTime }
  const zoneStates = new Map()

  // Debug telemetry: per-citizen movement & retarget counters so the click-
  // to-inspect overlay can answer "is this citizen actually moving?".
  const lastMovedSimT = new Float32Array(capacity)
  const totalMovedM = new Float32Array(capacity)
  const retargetCount = new Uint32Array(capacity)
  const lastRetargetSimT = new Float32Array(capacity)
  // Stuck-detection anchors. Periodically the engine checks each entity's
  // displacement from its last anchor — if a moving entity hasn't translated
  // far enough over the window, it's pinging back and forth on a tiny chunk
  // of road graph (a dead-end branch that survived graph pruning) and gets
  // forcibly respawned. Reset on respawn so consecutive checks don't fire.
  const stuckAnchorLat = new Float32Array(capacity)
  const stuckAnchorLng = new Float32Array(capacity)
  const stuckAnchorSimT = new Float32Array(capacity)
  const STUCK_WINDOW_S = 25
  const STUCK_DISPLACEMENT_M = 35

  // Building_Fire evacuee bookkeeping.
  //   alive          — 1 = live slot, 0 = freed (despawned or never spawned)
  //   linkedZoneId   — string id of the Building_Fire that spawned this slot,
  //                    or null for the ambient pool
  //   homeNode       — road-graph node id where this evacuee returns before
  //                    despawning
  //   returningHome  — 1 once the linked zone is gone and the evacuee is en
  //                    route home. Suppresses the leash so they BFS straight back.
  const alive = new Uint8Array(capacity)
  const linkedZoneId = new Array(capacity).fill(null)
  const homeNode = new Array(capacity).fill(null)
  const returningHome = new Uint8Array(capacity)

  // Agent kind per slot.
  //   0 = citizen (default — applies to the ambient pool and Building_Fire evacuees)
  //   1 = fire_truck
  // Reserved for ambulance/police later.
  const kind = new Uint8Array(capacity)

  // Fire-truck bookkeeping.
  //   truckRole       — state-machine slot (see TRUCK_ROLE below)
  //   truckTargetZoneId  — the specific zone the truck is approaching /
  //                        extinguishing (set after perception scan)
  //   truckStationLat/Lng — where the truck returns to
  //   truckDispatchId    — correlation id, lets recall() find this truck's batch
  //   truckPatrolNextAt  — sim time at which the truck will pick a new patrol
  //                        target (avoids retargeting every tick)
  //   truckPerceptionNextAt — sim time at which the truck next scans for fires
  //   truckSearchLat/Lng/RadiusM — operator-placed search circle. Trucks drive
  //                        to its centre, then patrol uniformly inside it
  //                        until they perceive smoke. Simulates an AI's
  //                        triangulated guess at the fire's location.
  //   truckPatrolStartedAt — sim time when the truck first entered PATROLLING.
  //                        Used to auto-return after ~90 s of fruitless patrol.
  const TRUCK_ROLE_EN_ROUTE = 0
  const TRUCK_ROLE_PATROLLING = 1
  const TRUCK_ROLE_APPROACHING = 2
  const TRUCK_ROLE_EXTINGUISHING = 3
  const TRUCK_ROLE_RETURNING = 4
  const truckRole = new Uint8Array(capacity)
  const truckTargetZoneId = new Array(capacity).fill(null)
  const truckStationLat = new Float32Array(capacity)
  const truckStationLng = new Float32Array(capacity)
  const truckDispatchId = new Array(capacity).fill(null)
  const truckPatrolNextAt = new Float32Array(capacity)
  const truckPerceptionNextAt = new Float32Array(capacity)
  const truckSearchLat = new Float32Array(capacity)
  const truckSearchLng = new Float32Array(capacity)
  const truckSearchRadiusM = new Float32Array(capacity)
  const truckPatrolStartedAt = new Float32Array(capacity)
  // Capacity per truck — read by the fightRate accumulator. Mirrors
  // FIRE_TRUCK_CAPACITY from config; stored per-slot so future ambulance/
  // police kinds can vary without engine code changes.
  const truckCapacity = new Uint8Array(capacity)

  // Per-tick aggregate of firefighters at each fire zone. Rebuilt each tick
  // by tickFireTruck during the EXTINGUISHING state; consumed by the wave /
  // building-fire integrator.
  const fightRate = new Map()
  // Per-fire intensity counter for Building_Fire zones (parallel to zoneStates
  // but for non-spreading point fires). Map<zoneId, { intensity, spreadAt,
  // childIds, hadFire }>. Created lazily when we first see an active
  // Building_Fire row.
  const buildingFireStates = new Map()

  // Cordon node set (citizens-only no-entry). Trucks ignore it.
  const cordonNodeSet = new Set()
  // Cache: for each notification id, the last sim time each citizen was
  // pushed out of it (avoids re-triggering on every tick).
  const notifAppliedAt = new Map()

  // Visual leash radius: a walking evacuee with homeNode set will reject
  // candidate neighbours whose destination is farther than this from home,
  // unless every option is outside (no-livelock fallback).
  const EVACUEE_TETHER_M = 150

  let simTimeS = 0
  let tickHandle = null
  const listeners = new Set()

  // Pick the next hop for a citizen wandering at random. Prefers neighbors
  // that are (a) not inside a hazard zone and (b) not the one they just came
  // from, so calm walkers don't drift back into a wildfire or bounce in
  // place. Falls back gracefully if every neighbor is hazardous (e.g. a
  // citizen who was just released from fleeing while still surrounded by
  // hazard nodes).
  function pickRandomWalkNext(currentId, avoidId, tetherHomeId) {
    const ns = roadGraph.neighbors(currentId)
    if (ns.length === 0) return null
    let pool = ns
    if (hazardNodeSet.size > 0) {
      const safe = pool.filter((n) => !hazardNodeSet.has(n.to))
      if (safe.length > 0) pool = safe
    }
    if (avoidId != null && pool.length > 1) {
      const filtered = pool.filter((n) => n.to !== avoidId)
      if (filtered.length > 0) pool = filtered
    }
    // Citizen-only cordon avoidance: drop any candidate whose destination is
    // inside an active cordon. If literally every option is cordoned (e.g. the
    // citizen is already inside one), fall through — they stay put effectively
    // because retargetForState will keep retrying.
    if (cordonNodeSet.size > 0) {
      const free = pool.filter((n) => !cordonNodeSet.has(n.to))
      if (free.length > 0) pool = free
      else return null  // surrounded by cordon → freeze (no walk this tick)
    }
    // Building_Fire evacuee leash: drop candidates that would carry the citizen
    // farther than EVACUEE_TETHER_M from their home node. If no candidate
    // qualifies (every neighbour is outside the tether — e.g. an evacuee
    // already at the edge), fall through so they aren't frozen.
    if (tetherHomeId != null) {
      const homeLoc = roadGraph.nodeLocation(tetherHomeId)
      if (homeLoc) {
        const within = pool.filter((n) => {
          const dest = roadGraph.nodeLocation(n.to)
          if (!dest) return false
          return distanceMeters(homeLoc.lat, homeLoc.lng, dest.lat, dest.lng) <= EVACUEE_TETHER_M
        })
        if (within.length > 0) pool = within
      }
    }
    return pool[Math.floor(Math.random() * pool.length)].to
  }

  function spawn(idx) {
    const start = roadGraph.getRandomNode()
    const loc = roadGraph.nodeLocation(start)
    lats[idx] = loc.lat
    lngs[idx] = loc.lng
    currentNode[idx] = start
    prevNode[idx] = null
    states[idx] = 'walking'
    stateExpiresAt[idx] = 0
    // Reset stuck-check anchor for this slot so a fresh spawn doesn't
    // inherit the previous occupant's history.
    stuckAnchorLat[idx] = loc.lat
    stuckAnchorLng[idx] = loc.lng
    stuckAnchorSimT[idx] = simTimeS
    // Defensive: reset evacuee bookkeeping in case this slot is being reused
    // by an ambient respawn rather than a Building_Fire spawn.
    alive[idx] = 1
    linkedZoneId[idx] = null
    homeNode[idx] = null
    returningHome[idx] = 0
    // Walkers wander one block at a time; retargetForState supplies the next
    // hop each time they reach an intersection. BFS is reserved for citizens
    // who actually have a destination (fleeing/approaching a hazard).
    const nextId = pickRandomWalkNext(start, null)
    if (nextId != null) {
      targetNode[idx] = nextId
      path[idx] = [start, nextId]
    } else {
      targetNode[idx] = start
      path[idx] = [start]
    }
  }

  for (let i = 0; i < count; i++) spawn(i)

  function transition(idx, newState) {
    states[idx] = newState
    const dur = STATE_DURATION_S[newState] ?? 0
    stateExpiresAt[idx] = dur === Infinity ? Infinity : simTimeS + dur
    if (newState === 'walking') {
      causeZoneId[idx] = null
      recoveryAt[idx] = 0
    }
  }

  // How far to project the flee target. Short enough that the citizen
  // reaches the area in one or two flee cycles; long enough that they
  // actually escape the perception buffer of large polygons.
  const FLEE_DISTANCE_M = 800

  function pickFleeTarget(idx, awayFrom) {
    // Strategy: aim for a fixed distance in the flee direction, then snap
    // to the closest road node. Without a distance cap, pickFleeTarget can
    // assign citizens a target at the far end of Manhattan (6+ km away) —
    // they spend the entire flee duration covering ~225m of a 22km path.
    const myLat = lats[idx]
    const myLng = lngs[idx]
    const dirLat = myLat - awayFrom.lat
    const dirLng = myLng - awayFrom.lng
    const dirMag = Math.hypot(dirLat, dirLng)

    // If citizen is exactly at the threat, just pick any node — direction is
    // undefined.
    if (dirMag < 1e-9) return roadGraph.getRandomNode()

    // Ideal target point: FLEE_DISTANCE_M metres past the citizen in the
    // radial-away direction. Convert meters to lat/lng degrees.
    const normLat = dirLat / dirMag
    const normLng = dirLng / dirMag
    const M_PER_DEG_LAT = 111111
    const M_PER_DEG_LNG = 111111 * Math.cos((myLat * Math.PI) / 180)
    const targetLat = myLat + (normLat * FLEE_DISTANCE_M) / M_PER_DEG_LAT
    const targetLng = myLng + (normLng * FLEE_DISTANCE_M) / M_PER_DEG_LNG

    // Snap to the actual nearest road node via the road graph's spatial
    // index. Random sampling (used previously) was way too sparse — Manhattan
    // has ~37k nodes spread over 84 km², so the "nearest of 60 random
    // samples" was typically ~1km off in some unpredictable direction,
    // including back toward the threat.
    const nearest = roadGraph.findNearestNode(targetLat, targetLng)
    return nearest || roadGraph.getRandomNode()
  }

  function pickApproachTarget(idx, towards) {
    // Use the spatial index for a real "closest node to event center" lookup
    // (random sampling was unreliable).
    return roadGraph.findNearestNode(towards.lat, towards.lng) || roadGraph.getRandomNode()
  }

  function retarget(idx, newTargetId) {
    targetNode[idx] = newTargetId
    const found = roadGraph.bfs(currentNode[idx], newTargetId)
    if (found && found.length >= 2) {
      path[idx] = found
      return
    }
    // BFS bailed (unreachable subgraph). Try a random neighbor of the
    // current node.
    const neighbors = roadGraph.neighbors(currentNode[idx])
    if (neighbors.length > 0) {
      const nextId = neighbors[Math.floor(Math.random() * neighbors.length)].to
      path[idx] = [currentNode[idx], nextId]
      return
    }
    // No outgoing neighbors → citizen is on an orphan node (bridge stub,
    // polygon-clipped fragment, etc). Respawn at a random valid node so they
    // don't freeze forever.
    const respawnId = roadGraph.getRandomNode()
    const loc = roadGraph.nodeLocation(respawnId)
    if (loc) {
      lats[idx] = loc.lat
      lngs[idx] = loc.lng
      currentNode[idx] = respawnId
    }
    path[idx] = [respawnId]
  }

  // Pick a new target that respects the citizen's current state. Critical
  // for fleeing/approaching: without this, a citizen who reaches their flee
  // target would re-target to a random node — sometimes back toward the
  // threat — losing the "flee" intent until the state expires.
  //
  // Walking citizens take random single-hop walks instead of BFS routes to a
  // far-away random node. BFS is reserved for the reactive states because
  // those need to actually reach somewhere specific (away from / toward a
  // hazard). For calm walkers, a long BFS path produces minutes of
  // unbroken straight-line motion along a single avenue, which reads as
  // citizens stubbornly refusing to turn.
  function retargetForState(idx, zones) {
    retargetCount[idx] += 1
    lastRetargetSimT[idx] = simTimeS
    const s = states[idx]
    const cause = causeZoneId[idx]
    if ((s === 'fleeing' || s === 'approaching') && cause) {
      const zone = zones.find((z) => z.id === cause)
      if (zone) {
        const ec = eventCenter(zone)
        if (ec) {
          const target =
            s === 'fleeing'
              ? pickFleeTarget(idx, ec)
              : pickApproachTarget(idx, ec)
          if (target) {
            retarget(idx, target)
            return
          }
        }
      }
    }
    if (s === 'walking') {
      // Tether evacuees to their building (only while they're milling — once
      // returningHome is set, the explicit BFS retarget below takes over and
      // the leash mustn't interfere with the path home).
      const tether = !returningHome[idx] ? homeNode[idx] : null
      const nextId = pickRandomWalkNext(currentNode[idx], prevNode[idx], tether)
      if (nextId != null) {
        targetNode[idx] = nextId
        path[idx] = [currentNode[idx], nextId]
        return
      }
      // Dead end (no outgoing neighbors). Fall through to retarget's respawn.
    }
    retarget(idx, roadGraph.getRandomNode())
  }

  function advanceAlongPath(idx, dtS, zones) {
    const p = path[idx]
    if (!p || p.length < 2) {
      // Trucks have their own retarget logic in tickFireTruck — calling
      // retargetForState here would dump them on a random node.
      if (kind[idx] !== 1) retargetForState(idx, zones)
      return
    }
    const speed = SPEED_MPS[states[idx]] ?? SPEED_MPS.walking
    if (speed <= 0) return

    const startLat = lats[idx]
    const startLng = lngs[idx]

    let remaining = speed * dtS
    while (remaining > 0 && p.length >= 2) {
      // Citizen cordon block: if the next hop along the path enters a
      // cordoned node, freeze in place. Trucks ignore cordons.
      if (kind[idx] === 0 && cordonNodeSet.has(p[1])) {
        break
      }
      const a = roadGraph.nodeLocation(p[0])
      const b = roadGraph.nodeLocation(p[1])
      const segLen = distanceMeters(lats[idx], lngs[idx], b.lat, b.lng)
      if (segLen <= remaining) {
        prevNode[idx] = currentNode[idx]
        lats[idx] = b.lat
        lngs[idx] = b.lng
        currentNode[idx] = p[1]
        p.shift()
        remaining -= segLen
      } else {
        const t = remaining / segLen
        lats[idx] = lats[idx] + (b.lat - lats[idx]) * t
        lngs[idx] = lngs[idx] + (b.lng - lngs[idx]) * t
        remaining = 0
      }
    }

    const moved = distanceMeters(startLat, startLng, lats[idx], lngs[idx])
    if (moved > 0.01) {
      lastMovedSimT[idx] = simTimeS
      totalMovedM[idx] += moved
    }

    if (path[idx].length < 2) {
      // Same guard as the top of this function: trucks have their own
      // path-exhaustion logic in tickFireTruck (each role re-targets to its
      // own destination — search circle, fire, or station). Calling
      // retargetForState here would dump them on a random city node.
      if (kind[idx] !== 1) retargetForState(idx, zones)
    }
  }

  function buildZoneIndex(zones) {
    // Three categories driven by geometryKind (set during zone creation),
    // NOT by the GeoJSON shape — a Geoman-drawn circle is geometry.type='Point'
    // with radius_metres, but it's semantically an area (geometryKind: 'area')
    // and must go through the area / spreading-hazard code path.
    //   citywide → applies to every citizen each tick (no geometry check)
    //   areas    → polygon or circle; checked exhaustively per citizen
    //   pointIdx → spatial index for true point events (Robbery, Accident, …)
    const pointIdx = new SpatialIndex()
    const citywide = []
    const areas = []
    for (const z of zones) {
      // Untriggered (draft) zones are invisible to the citizen sim. They live
      // in the local state only so the operator can compose a scenario; weather
      // sees them via the backend but citizens don't react until Trigger.
      if (z.triggeredAt == null) continue
      if (z.geometryKind === 'city') {
        citywide.push(z)
        continue
      }
      if (z.geometryKind === 'area') {
        areas.push(z)
        continue
      }
      // geometryKind === 'point' (or legacy zones with no kind)
      const c = eventCenter(z)
      if (!c) continue
      pointIdx.insert({ zone: z, center: c }, c.lat, c.lng)
    }
    return { pointIdx, citywide, areas }
  }

  // Lazily-built per-zone state for spreading hazards (Flood, Wildfire).
  // Returns null for zones without a geometry centroid.
  function ensureZoneState(zone, profile) {
    let s = zoneStates.get(zone.id)
    if (s) return s
    const centroid = eventCenter(zone)
    if (!centroid) return null
    const maxRadius = maxRadiusFromCentroid(zone.geometry, centroid)
    if (maxRadius <= 0) return null
    s = {
      // Wave clock anchored at the moment the zone was triggered (in sim
      // seconds). Fallback to now for safety, though buildZoneIndex filters
      // non-triggered zones out before we reach here.
      startTime: zone.triggeredAt ?? simTimeS,
      // Last sim time we integrated this zone's radius. Together with the
      // running `radius` value below, this lets firefighter fightRate shrink
      // the wave — we can't reconstruct that from a pure t = simTimeS - start
      // formula because the effective spread rate varies per tick.
      lastTickT: zone.triggeredAt ?? simTimeS,
      // Running wave radius (metres). Integrated each tick by the pre-loop
      // step in tick(); read by getZoneWaves and the per-citizen catch.
      radius: 0,
      centroid,
      maxRadius,
      // Spread rate in sim-meters-per-sim-second.
      spreadRate: profile.spreadRateMps?.(zone.severity ?? 1) || 3,
      // Per-zone multiplier from the operator's slider (default 1×).
      spreadSpeed: zone.spreadSpeed ?? 1,
      color: profile.color || '#3b82f6',
      type: zone.type,
      severity: zone.severity ?? 1,
    }
    zoneStates.set(zone.id, s)
    return s
  }

  function currentWaveRadius(state) {
    // Integration happens in tick(); this is now a simple read.
    return state.radius
  }

  function reactToEvent(idx, zone, kind) {
    const profile = getProfile(zone.type)
    if (!profile) return
    // Citywide events have no center, so fleeing/approaching directions are
    // meaningless — those response modes degrade to a neutral shelter state.
    const ec = eventCenter(zone)

    const response =
      typeof profile.citizenResponse === 'function'
        ? profile.citizenResponse(zone.severity ?? 1)
        : profile.citizenResponse
    if (response === 'flee' && ec) {
      transition(idx, 'fleeing')
      retarget(idx, pickFleeTarget(idx, ec) || roadGraph.getRandomNode())
    } else if (response === 'approach' && ec) {
      transition(idx, 'approaching')
      retarget(idx, pickApproachTarget(idx, ec) || roadGraph.getRandomNode())
    } else if (response === 'hide') {
      transition(idx, 'hiding')
    } else if (response === 'shelter') {
      transition(idx, 'shelter')
    }
    // 'neutral' (or flee/approach against a citywide event): keep walking but
    // still emit the report below.

    // Record the zone that put this citizen into their reactive state so the
    // tick loop can release them once the zone is removed.
    if (states[idx] !== 'walking') {
      causeZoneId[idx] = zone.id
      recoveryAt[idx] = 0
    }

    const transcript =
      kind === 'affected'
        ? profile.symptomLabel || `Resident affected by ${profile.label} conditions.`
        : ec
          ? `Citizen reporting ${profile.label.toLowerCase()} near ${ec.lat.toFixed(4)}, ${ec.lng.toFixed(4)}.`
          : `Citizen reporting ${profile.label.toLowerCase()}.`

    onReport?.({
      event_id: zone.id,
      citizen_idx: idx,
      report_kind: kind,
      location: { lat: lats[idx], lng: lngs[idx] },
      transcript,
      perceived_severity: zone.severity,
    })
  }

  function maybeReport(idx, zone, kind) {
    // `last` is undefined the first time this citizen encounters this zone —
    // distinguish that from "reported at t=0" so we don't suppress every
    // first-time report during the first 30 seconds of sim time.
    const last = reportLog[idx].get(zone.id)
    if (last !== undefined && simTimeS - last < REPORT_COOLDOWN_S) return false
    reportLog[idx].set(zone.id, simTimeS)
    reactToEvent(idx, zone, kind)
    return true
  }

  // Common branch for "affect roll passed" — checks whether the symptom is
  // severe enough that the citizen faints (silent, becomes a future witness
  // report) or merely feels unwell (self-reports the standard 'affected' call).
  function applyAffected(idx, zone, profile) {
    const faintChance = profile.faintChance?.(zone.severity ?? 1) || 0
    if (faintChance > 0 && Math.random() < faintChance) {
      transition(idx, 'fainted')
      causeZoneId[idx] = zone.id
      recoveryAt[idx] = 0
      // No self-report: an unconscious person can't dial 911. A passing
      // witness will see them and emit the report.
      return
    }
    transition(idx, 'affected')
    maybeReport(idx, zone, 'affected')
  }

  function detectEvents(idx, zoneIndex, dtS) {
    // Spreading-hazard catch FIRST, regardless of state. A fleeing citizen
    // is still vulnerable to the wave; if they're inside the polygon and
    // inside the current wave radius they get caught even if they were
    // already mid-reaction. Skip only if they're already a casualty.
    if (states[idx] !== 'affected' && states[idx] !== 'fainted') {
      for (const zone of zoneIndex.areas) {
        const profile = getProfile(zone.type)
        if (!profile?.spreads) continue
        if (!isCitizenInsideZone(lats[idx], lngs[idx], zone)) continue
        const state = ensureZoneState(zone, profile)
        if (!state) continue
        const dLat = ((state.centroid.lat - lats[idx]) * Math.PI) / 180
        const dLng = ((state.centroid.lng - lngs[idx]) * Math.PI) / 180
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((lats[idx] * Math.PI) / 180) *
            Math.cos((state.centroid.lat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2
        const distToCenter = 2 * EARTH_R * Math.asin(Math.sqrt(a))
        if (distToCenter <= currentWaveRadius(state)) {
          applyAffected(idx, zone, profile)
          return
        }
      }
    }

    // Don't re-trigger non-catch events if the citizen is mid-reaction.
    if (states[idx] !== 'walking') return

    // affectChance values in the profile are "per sim-second probability";
    // scale by dtS so the effective rate stays constant across tick rates.
    // (faintChance stays unscaled — it's a fraction conditional on the
    // affect roll passing, not a rate.)

    // 1. City-wide events: every citizen rolls every tick.
    for (const zone of zoneIndex.citywide) {
      const profile = getProfile(zone.type)
      if (!profile || profile.reportingMode !== 'affected') continue
      const chance = (profile.affectChance?.(zone.severity ?? 1) || 0) * dtS
      if (Math.random() < chance) {
        applyAffected(idx, zone, profile)
        return
      }
    }

    // 2. Area zones (drawn polygons OR drawn circles): check every citizen
    //    against every one. Cheap at this scale (~10 zones × 1500 citizens
    //    = 15k point-in-zone checks per tick).
    for (const zone of zoneIndex.areas) {
      const profile = getProfile(zone.type)
      if (!profile) continue

      // (Wave catch for spreading hazards is handled upfront in detectEvents
      // before the walking-only gate, so it applies to fleeing citizens too.)

      if (profile.reportingMode === 'affected') {
        if (isCitizenInsideZone(lats[idx], lngs[idx], zone)) {
          const chance = (profile.affectChance?.(zone.severity ?? 1) || 0) * dtS
          if (Math.random() < chance) {
            applyAffected(idx, zone, profile)
            return
          }
        }
        continue
      }

      // Observation area zones. For spreading hazards (Flood, Wildfire) the
      // observable region tracks the *current* wave front, not the polygon —
      // citizens far ahead of the wave don't see it yet. For non-spreading
      // observation-area zones (none today; defensive) fall back to the
      // polygon-membership + perception buffer rule.
      const center = eventCenter(zone)
      if (!center) continue
      const { visual, audible } = getPerception(zone.type, zone.severity ?? 1)
      const perception = Math.max(visual, audible)

      if (profile.spreads) {
        const state = ensureZoneState(zone, profile)
        if (!state) continue
        const d = distanceMeters(lats[idx], lngs[idx], center.lat, center.lng)
        const reach = currentWaveRadius(state) + perception
        if (reach > 0 && d <= reach) {
          maybeReport(idx, zone, 'observation')
          return
        }
      } else {
        const inside = isCitizenInsideZone(lats[idx], lngs[idx], zone)
        const d = inside ? 0 : distanceMeters(lats[idx], lngs[idx], center.lat, center.lng)
        if (inside || (perception > 0 && d <= perception)) {
          maybeReport(idx, zone, 'observation')
          return
        }
      }
    }

    // 3. Point events: use the spatial index for cheap perception-radius lookups.
    const candidates = zoneIndex.pointIdx.near(lats[idx], lngs[idx])
    for (const { zone, center } of candidates) {
      const profile = getProfile(zone.type)
      if (!profile) continue
      const d = distanceMeters(lats[idx], lngs[idx], center.lat, center.lng)

      if (profile.reportingMode === 'affected') {
        if (isCitizenInsideZone(lats[idx], lngs[idx], zone)) {
          const chance = (profile.affectChance?.(zone.severity ?? 1) || 0) * dtS
          if (Math.random() < chance) {
            applyAffected(idx, zone, profile)
            return
          }
        }
        continue
      }

      // Observation mode: visual or audible radius hits.
      const { visual, audible } = getPerception(zone.type, zone.severity ?? 1)
      const reach = Math.max(visual, audible)
      if (reach > 0 && d <= reach) {
        maybeReport(idx, zone, 'observation')
        return
      }
    }
  }

  function buildFaintedList() {
    // Typically 0–10 fainted citizens at once; a flat array is fine.
    const out = []
    for (let i = 0; i < activeCount; i++) {
      if (!alive[i]) continue
      if (states[i] === 'fainted') {
        out.push({ idx: i, lat: lats[i], lng: lngs[i], causeZoneId: causeZoneId[i] })
      }
    }
    return out
  }

  function maybeWitnessReport(witnessIdx, fainted, zones) {
    // Cooldown key segregated from regular zone reports so one doesn't suppress
    // the other.
    const key = `witness:${fainted.idx}`
    const last = reportLog[witnessIdx].get(key)
    if (last !== undefined && simTimeS - last < REPORT_COOLDOWN_S) return
    reportLog[witnessIdx].set(key, simTimeS)

    const causeZone = fainted.causeZoneId
      ? zones.find((z) => z.id === fainted.causeZoneId)
      : null
    // If the causing event is gone, we can't FK the report to anything in the
    // backend — drop silently. The witness still notices but the AI consumer
    // has no event context to attach it to.
    if (!causeZone) return

    const profile = getProfile(causeZone.type)
    const causeLabel = profile?.label?.toLowerCase() || 'medical emergency'
    onReport?.({
      event_id: causeZone.id,
      citizen_idx: witnessIdx,
      report_kind: 'observation',
      location: { lat: lats[witnessIdx], lng: lngs[witnessIdx] },
      transcript: `Bystander reports an unconscious person near ${fainted.lat.toFixed(4)}, ${fainted.lng.toFixed(4)} — possible ${causeLabel} casualty.`,
      perceived_severity: causeZone.severity,
    })
  }

  // Same shape as rebuildHazardSet but for operator cordons. Citizens read
  // this in pickRandomWalkNext + advanceAlongPath; trucks ignore it.
  function rebuildCordonSet(cordons) {
    cordonNodeSet.clear()
    if (!cordons || cordons.length === 0) return
    const bboxCandidates = []
    for (const c of cordons) {
      const g = c?.geometry
      if (!g) continue
      let latMin, latMax, lngMin, lngMax
      if (g.type === 'Polygon' && Array.isArray(g.coordinates?.[0])) {
        latMin = Infinity; latMax = -Infinity; lngMin = Infinity; lngMax = -Infinity
        for (const [lng, lat] of g.coordinates[0]) {
          if (lat < latMin) latMin = lat
          if (lat > latMax) latMax = lat
          if (lng < lngMin) lngMin = lng
          if (lng > lngMax) lngMax = lng
        }
      } else {
        continue
      }
      bboxCandidates.length = 0
      roadGraph.nodeIdsInBbox(latMin, latMax, lngMin, lngMax, bboxCandidates)
      for (const nodeId of bboxCandidates) {
        if (cordonNodeSet.has(nodeId)) continue
        const loc = roadGraph.nodeLocation(nodeId)
        if (loc && pointInPolygon(loc.lat, loc.lng, g.coordinates[0])) {
          cordonNodeSet.add(nodeId)
        }
      }
    }
  }

  // Point-in-polygon test for [lng, lat] coordinate ring. Standard ray-casting.
  function pointInPolygon(lat, lng, ring) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = [ring[i][0], ring[i][1]]
      const [xj, yj] = [ring[j][0], ring[j][1]]
      const intersect = yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi
      if (intersect) inside = !inside
    }
    return inside
  }

  // Repopulate hazardNodeSet from current area-zone geometry. Cheap thanks
  // to the road graph's bucket index — we only run the expensive
  // point-in-zone check against nodes whose lat/lng bucket lies within the
  // zone's bounding box.
  function rebuildHazardSet(zones) {
    hazardNodeSet.clear()
    if (!zones.length) return
    const bboxCandidates = []
    for (const zone of zones) {
      if (zone.geometryKind !== 'area' || !zone.geometry) continue
      let latMin, latMax, lngMin, lngMax
      if (zone.geometry.type === 'Point') {
        const [lng, lat] = zone.geometry.coordinates
        const r = zone.geometry.radius_metres || 0
        if (r <= 0) continue
        const dLat = r / 111111
        const dLng = r / (111111 * Math.cos((lat * Math.PI) / 180))
        latMin = lat - dLat; latMax = lat + dLat
        lngMin = lng - dLng; lngMax = lng + dLng
      } else if (zone.geometry.type === 'Polygon') {
        latMin = Infinity; latMax = -Infinity
        lngMin = Infinity; lngMax = -Infinity
        for (const [lng, lat] of zone.geometry.coordinates[0]) {
          if (lat < latMin) latMin = lat
          if (lat > latMax) latMax = lat
          if (lng < lngMin) lngMin = lng
          if (lng > lngMax) lngMax = lng
        }
      } else {
        continue
      }
      bboxCandidates.length = 0
      roadGraph.nodeIdsInBbox(latMin, latMax, lngMin, lngMax, bboxCandidates)
      for (const nodeId of bboxCandidates) {
        if (hazardNodeSet.has(nodeId)) continue
        const loc = roadGraph.nodeLocation(nodeId)
        if (loc && isCitizenInsideZone(loc.lat, loc.lng, zone)) {
          hazardNodeSet.add(nodeId)
        }
      }
    }
  }

  function tick(dtS) {
    simTimeS += dtS
    const zones = getZones?.() || []
    const notifications = getNotifications?.() || []
    const cordons = getCordons?.() || []
    const zoneIndex = buildZoneIndex(zones)
    const activeIds = new Set(zones.map((z) => z.id))
    const fainted = buildFaintedList()
    rebuildHazardSet(zones)
    rebuildCordonSet(cordons)
    // Reset per-tick fight-rate accumulator. Trucks in EXTINGUISHING role
    // contribute to this Map during their tick, then the wave/intensity
    // integrators consume it (see further down).
    fightRate.clear()

    // Drop wave state for zones that have been removed.
    for (const id of zoneStates.keys()) {
      if (!activeIds.has(id)) zoneStates.delete(id)
    }
    // Same for Building_Fire intensity records.
    for (const id of buildingFireStates.keys()) {
      if (!activeIds.has(id)) buildingFireStates.delete(id)
    }

    // Pre-warm wave state for every triggered spreading zone so the wave
    // starts expanding from the moment of trigger, regardless of whether a
    // citizen happens to be nearby. Without this, ensureZoneState only fires
    // on first interaction; combined with `startTime = zone.triggeredAt`, the
    // wave would snap forward by however much sim-time has elapsed since
    // trigger — making remote second zones appear instantly mostly-finished.
    for (const zone of zoneIndex.areas) {
      if (zone.triggeredAt == null) continue
      const profile = getProfile(zone.type)
      if (profile?.spreads) ensureZoneState(zone, profile)
    }

    // Wave-radius integrator: state.radius += naturalGrowth - fightContribution.
    // Naturally grows at spreadRate × spreadSpeed (matches the previous closed-
    // form `elapsed * rate`); shrinks proportional to firefighters within reach.
    // When radius hits 0 *while* being fought, the zone is resolved (DELETE +
    // local removal in the dashboard via the onZoneResolved callback).
    const resolvedThisTick = []
    for (const [zoneId, state] of zoneStates) {
      const dt = Math.max(0, simTimeS - state.lastTickT)
      state.lastTickT = simTimeS
      if (dt <= 0) continue
      const ff = fightRate.get(zoneId) || 0
      const grow = state.spreadRate * state.spreadSpeed * dt
      const shrink = ff * EXTINGUISH_RATE_PER_FF_M_PER_S * dt
      let r = state.radius + grow - shrink
      if (r > state.maxRadius) r = state.maxRadius
      if (r <= 0 && ff > 0) {
        // Fully extinguished — schedule for resolution.
        r = 0
        resolvedThisTick.push(zoneId)
      } else if (r < 0) {
        r = 0
      }
      state.radius = r
    }

    // Building_Fire intensity integrator + delayed-spread scheduler.
    for (const zone of zones) {
      if (zone.type !== 'Building_Fire' || zone.status !== 'active') continue
      let bf = buildingFireStates.get(zone.id)
      if (!bf) {
        bf = {
          intensity: (zone.severity ?? 1) * 10,
          spreadAt: zone.spreadInSeconds != null
            ? (zone.triggeredAt ?? simTimeS) + zone.spreadInSeconds
            : Infinity,
          lastTickT: simTimeS,
          spreadFired: false,
        }
        buildingFireStates.set(zone.id, bf)
      }
      const dt = Math.max(0, simTimeS - bf.lastTickT)
      bf.lastTickT = simTimeS
      if (dt <= 0) continue
      const ff = fightRate.get(zone.id) || 0
      // Building fires don't naturally grow; they just persist until put out
      // or until the spread timer expires.
      bf.intensity -= ff * BUILDING_EXTINGUISH_RATE * dt
      if (bf.intensity <= 0 && ff > 0) {
        resolvedThisTick.push(zone.id)
        continue
      }
      // Delayed spread: when the timer expires and the parent isn't put out,
      // ask the dashboard to activate any draft children.
      if (!bf.spreadFired && simTimeS >= bf.spreadAt) {
        bf.spreadFired = true
        const childIds = zones.filter((z) => z.parent_id === zone.id || z.parentId === zone.id).map((z) => z.id)
        if (childIds.length > 0 && onScheduledSpread) {
          try { onScheduledSpread(zone.id, childIds) } catch { /* ignore */ }
        }
      }
    }

    for (const zid of resolvedThisTick) {
      zoneStates.delete(zid)
      buildingFireStates.delete(zid)
      // Recall any trucks targeting this zone — they'll transition to RETURNING.
      for (let i = 0; i < activeCount; i++) {
        if (kind[i] === 1 && truckTargetZoneId[i] === zid) {
          truckTargetZoneId[i] = null
          truckRole[i] = TRUCK_ROLE_RETURNING
          retarget(i, roadGraph.findNearestNode(truckStationLat[i], truckStationLng[i]) ?? roadGraph.getRandomNode())
        }
      }
      if (onZoneResolved) {
        try { onZoneResolved(zid) } catch { /* ignore */ }
      }
    }

    for (let i = 0; i < activeCount; i++) {
      // Despawned (Building_Fire evacuee that walked home) — skip everything.
      if (!alive[i]) continue

      // Stuck detection: if a moving entity hasn't displaced more than
      // STUCK_DISPLACEMENT_M from its anchor over STUCK_WINDOW_S, it's
      // ping-ponging on an isolated subgraph the polygon-clipping + dead-end
      // trimming didn't catch. Forcibly respawn (citizens) or send home
      // (trucks) to break the cycle. Skipped for stationary states (hiding,
      // affected, fainted, shelter, extinguishing) and tethered evacuees
      // (Building_Fire homeNode) which are *supposed* to stay near home.
      if (simTimeS - stuckAnchorSimT[i] >= STUCK_WINDOW_S) {
        const s = states[i]
        const isMoving =
          s === 'walking' || s === 'fleeing' || s === 'approaching' ||
          s === 'truck_driving' || s === 'truck_patrolling'
        const tethered = kind[i] === 0 && homeNode[i] != null
        if (isMoving && !tethered) {
          const d = distanceMeters(lats[i], lngs[i], stuckAnchorLat[i], stuckAnchorLng[i])
          if (d < STUCK_DISPLACEMENT_M) {
            // Reset anchor regardless so we don't fire every tick.
            stuckAnchorLat[i] = lats[i]
            stuckAnchorLng[i] = lngs[i]
            stuckAnchorSimT[i] = simTimeS
            if (kind[i] === 1) {
              // Truck: send straight home rather than respawning mid-city.
              truckRole[i] = TRUCK_ROLE_RETURNING
              truckTargetZoneId[i] = null
              states[i] = 'truck_driving'
              const hid = roadGraph.findNearestNode(truckStationLat[i], truckStationLng[i])
              if (hid != null) retarget(i, hid)
            } else {
              // Citizen: respawn at a random main-grid node and reset to walking.
              const newStart = roadGraph.getRandomNode()
              const newLoc = roadGraph.nodeLocation(newStart)
              if (newLoc) {
                lats[i] = newLoc.lat
                lngs[i] = newLoc.lng
                currentNode[i] = newStart
                prevNode[i] = null
                states[i] = 'walking'
                stateExpiresAt[i] = 0
                causeZoneId[i] = null
                const nextId = pickRandomWalkNext(newStart, null)
                if (nextId != null) {
                  targetNode[i] = nextId
                  path[i] = [newStart, nextId]
                } else {
                  targetNode[i] = newStart
                  path[i] = [newStart]
                }
              }
            }
          } else {
            // Made real progress — slide the anchor forward.
            stuckAnchorLat[i] = lats[i]
            stuckAnchorLng[i] = lngs[i]
            stuckAnchorSimT[i] = simTimeS
          }
        } else {
          // Stationary state or tethered — reset anchor so we don't false-positive
          // when they later resume moving.
          stuckAnchorLat[i] = lats[i]
          stuckAnchorLng[i] = lngs[i]
          stuckAnchorSimT[i] = simTimeS
        }
      }

      // Fire-truck branch: separate state machine; never falls through to the
      // citizen logic below.
      if (kind[i] === 1) {
        tickFireTruck(i, zoneIndex, zones, dtS)
        continue
      }

      // Notification consumption: walking citizens inside an active alert
      // polygon flee outward unless they're already mid-reaction.
      if (states[i] === 'walking' && notifications.length > 0) {
        for (const notif of notifications) {
          if (notif.status && notif.status !== 'active') continue
          const ring = notif.geometry?.coordinates?.[0]
          if (!ring) continue
          if (!pointInPolygon(lats[i], lngs[i], ring)) continue
          const seenKey = `${notif.id}:${i}`
          const last = notifAppliedAt.get(seenKey) ?? -Infinity
          if (simTimeS - last < 30) break  // already-applied cooldown
          notifAppliedAt.set(seenKey, simTimeS)
          // Centroid of the notification ring — flee away from it.
          let cLat = 0, cLng = 0
          for (const [lng, lat] of ring) { cLat += lat; cLng += lng }
          cLat /= ring.length; cLng /= ring.length
          transition(i, 'fleeing')
          retarget(i, pickFleeTarget(i, { lat: cLat, lng: cLng }) || roadGraph.getRandomNode())
          causeZoneId[i] = null
          break
        }
      }

      // 1. Natural expiry: reactive states with a fixed duration time out.
      if (
        states[i] !== 'walking' &&
        stateExpiresAt[i] !== Infinity &&
        simTimeS >= stateExpiresAt[i]
      ) {
        transition(i, 'walking')
      }

      // 2. Zone-removal recovery: if the disaster that put this citizen into
      //    a reactive state is no longer active, schedule a randomized return
      //    to walking so the population doesn't all snap back at once.
      if (states[i] !== 'walking' && causeZoneId[i] != null) {
        const stillActive = activeIds.has(causeZoneId[i])
        if (!stillActive) {
          if (recoveryAt[i] === 0) {
            // Stagger over 10–60 sim seconds for a believable "calm down".
            recoveryAt[i] = simTimeS + 10 + Math.random() * 50
          } else if (simTimeS >= recoveryAt[i]) {
            transition(i, 'walking')
          }
        } else {
          // Zone is back / still around — cancel any pending recovery.
          recoveryAt[i] = 0
        }
      }

      // 3. Building_Fire evacuee return-home: once the parent fire is gone
      //    and the citizen is back to walking, BFS them home and despawn on
      //    arrival. If they're mid-reaction (fleeing/fainted/etc.) we let the
      //    natural-expiry path bring them back to walking first. After a
      //    reactive interrupt, retargetForState picks a random neighbour, so
      //    we re-retarget to homeNode every tick the citizen isn't already
      //    pointed at it.
      if (linkedZoneId[i] != null && !activeIds.has(linkedZoneId[i]) && states[i] === 'walking') {
        if (currentNode[i] === homeNode[i]) {
          alive[i] = 0
          lats[i] = NaN
          lngs[i] = NaN
          linkedZoneId[i] = null
          homeNode[i] = null
          returningHome[i] = 0
          liveCount--
          continue
        }
        returningHome[i] = 1
        if (targetNode[i] !== homeNode[i]) {
          retarget(i, homeNode[i])
        }
      }

      advanceAlongPath(i, dtS, zones)
      detectEvents(i, zoneIndex, dtS)

      // Witness scan: walking citizens who pass within WITNESS_PERCEPTION_M of
      // an unconscious person call 911 on their behalf. Skip if this citizen
      // is the fainter, or already in a reactive state.
      if (states[i] === 'walking' && fainted.length > 0) {
        for (const f of fainted) {
          if (f.idx === i) continue
          const d = distanceMeters(lats[i], lngs[i], f.lat, f.lng)
          if (d <= WITNESS_PERCEPTION_M) {
            maybeWitnessReport(i, f, zones)
            break
          }
        }
      }
    }
    notifyListeners()
  }

  function notifyListeners() {
    for (const cb of listeners) cb()
  }

  // Speed multiplier: how many sim-seconds pass per real second.
  //   0   → paused (no ticks)
  //   1   → real-time
  //   N>1 → fast-forward; tick interval shrinks and dtS scales to match
  let speedMultiplier = 1

  function applySpeed() {
    if (tickHandle) {
      clearInterval(tickHandle)
      tickHandle = null
    }
    if (speedMultiplier <= 0) return
    // Cap real-time tick frequency at 20 Hz so very high multipliers don't
    // melt the browser; dtS scaling means the sim still runs at the requested
    // speed even if visual updates are throttled.
    const intervalMs = Math.max(50, 1000 / speedMultiplier)
    let lastT = performance.now()
    tickHandle = setInterval(() => {
      const now = performance.now()
      // Clamp to 2 s so a backgrounded tab doesn't teleport citizens, but a
      // normal 1 Hz tick (≈1 s real-time at speed=1) passes through unscaled.
      // Earlier 0.25 s clamp throttled every tick at speed=1 to a quarter of
      // its intended dt — citizens moved ~1 m/s instead of 4 m/s, which is
      // sub-pixel at zoom 14 and made walking dots look frozen.
      const realDt = Math.min(2, (now - lastT) / 1000)
      lastT = now
      tick(realDt * speedMultiplier)
    }, intervalMs)
  }

  function start() {
    if (tickHandle) return
    applySpeed()
  }

  function stop() {
    if (tickHandle) {
      clearInterval(tickHandle)
      tickHandle = null
    }
  }

  function setSpeed(multiplier) {
    speedMultiplier = Math.max(0, Math.min(20, Number(multiplier) || 0))
    // If the engine was running, restart the interval at the new rate.
    // If it was paused (0) and we're going to >0, kick it on.
    if (tickHandle || speedMultiplier > 0) applySpeed()
  }

  function snapshot() {
    // count is the iteration bound (high-water mark of slot indices ever used).
    // Dead slots in [0..count) have NaN lat/lng — renderers iterating up to
    // count naturally draw nothing for them (Canvas / Leaflet skip NaN coords).
    // liveCount is the displayed citizen total (alive only).
    // kind lets the renderer pick the right style per slot (citizen vs truck).
    return { lats, lngs, states, kind, count: activeCount, liveCount }
  }

  function pathRemainingMeters(idx) {
    const p = path[idx]
    if (!p || p.length < 2) return 0
    let total = 0
    const next = roadGraph.nodeLocation(p[1])
    if (next) total += distanceMeters(lats[idx], lngs[idx], next.lat, next.lng)
    for (let i = 1; i < p.length - 1; i++) {
      const a = roadGraph.nodeLocation(p[i])
      const b = roadGraph.nodeLocation(p[i + 1])
      if (a && b) total += distanceMeters(a.lat, a.lng, b.lat, b.lng)
    }
    return total
  }

  // Full per-citizen state dump for debugging. Used by the click-to-inspect
  // overlay so we can diagnose why a particular dot isn't behaving.
  function getCitizenStats(idx) {
    if (idx < 0 || idx >= activeCount) return null
    if (!alive[idx]) return null
    const p = path[idx] || []
    return {
      idx,
      simTimeS,
      lat: lats[idx],
      lng: lngs[idx],
      state: states[idx],
      speed: SPEED_MPS[states[idx]] ?? SPEED_MPS.walking,
      currentNode: currentNode[idx],
      targetNode: targetNode[idx],
      pathLength: p.length,
      pathRemainingM: pathRemainingMeters(idx),
      neighborCount: (roadGraph.neighbors(currentNode[idx]) || []).length,
      // Movement telemetry
      lastMovedSimT: lastMovedSimT[idx],
      ticksStillSinceMove: simTimeS - lastMovedSimT[idx],
      totalMovedM: totalMovedM[idx],
      retargetCount: retargetCount[idx],
      lastRetargetSimT: lastRetargetSimT[idx],
      // State context
      causeZoneId: causeZoneId[idx],
      stateExpiresAt: stateExpiresAt[idx],
      recoveryAt: recoveryAt[idx],
      reportLogSize: reportLog[idx].size,
    }
  }

  // Currently-active wave fronts for spreading hazards. Consumers can use
  // this to render an expanding circle inside each Flood/Wildfire polygon.
  function getZoneWaves() {
    const out = []
    for (const [id, state] of zoneStates) {
      out.push({
        zoneId: id,
        lat: state.centroid.lat,
        lng: state.centroid.lng,
        radius: currentWaveRadius(state),
        maxRadius: state.maxRadius,
        color: state.color,
        type: state.type,
        severity: state.severity,
      })
    }
    return out
  }

  function subscribe(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  function getCurrentTime() {
    return simTimeS
  }

  // Spawn `n` Building_Fire evacuees at the building location. Each spawned
  // citizen:
  //   - is anchored at the nearest road node (the building's "home node")
  //   - starts in 'fleeing' state with a target ~100 m away in a random
  //     outward direction (the visible emerge animation)
  //   - is linked to `zoneId` so they can despawn when the fire is removed
  // Returns the number actually spawned (capped by remaining capacity).
  function spawnFleeingCitizens(zoneId, loc, n) {
    if (!zoneId || !loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return 0
    const homeNodeId = roadGraph.findNearestNode(loc.lat, loc.lng) ?? roadGraph.getRandomNode()
    if (homeNodeId == null) return 0
    const homeLoc = roadGraph.nodeLocation(homeNodeId)
    if (!homeLoc) return 0
    const M_PER_DEG_LAT = 111111
    const M_PER_DEG_LNG = 111111 * Math.cos((homeLoc.lat * Math.PI) / 180)
    const EMERGE_M = 100

    let added = 0
    while (added < n) {
      // Reuse a despawned slot if one exists; otherwise extend the high-water
      // mark up to capacity.
      let idx = -1
      for (let i = 0; i < activeCount; i++) {
        if (!alive[i]) { idx = i; break }
      }
      if (idx < 0) {
        if (activeCount >= capacity) break
        idx = activeCount
        activeCount++
      }

      lats[idx] = homeLoc.lat
      lngs[idx] = homeLoc.lng
      currentNode[idx] = homeNodeId
      prevNode[idx] = null
      causeZoneId[idx] = null
      recoveryAt[idx] = 0
      lastMovedSimT[idx] = simTimeS
      totalMovedM[idx] = 0
      retargetCount[idx] = 0
      lastRetargetSimT[idx] = simTimeS
      reportLog[idx].clear()
      states[idx] = 'fleeing'
      const dur = STATE_DURATION_S.fleeing ?? 0
      stateExpiresAt[idx] = dur === Infinity ? Infinity : simTimeS + dur

      // Pick a random outward bearing and project ~100 m, then snap to the
      // nearest road node. This produces the "pouring out" effect — each
      // evacuee runs in a slightly different direction.
      const theta = Math.random() * Math.PI * 2
      const outwardLat = homeLoc.lat + (Math.sin(theta) * EMERGE_M) / M_PER_DEG_LAT
      const outwardLng = homeLoc.lng + (Math.cos(theta) * EMERGE_M) / M_PER_DEG_LNG
      const targetId = roadGraph.findNearestNode(outwardLat, outwardLng) ?? roadGraph.getRandomNode()
      retarget(idx, targetId)

      alive[idx] = 1
      linkedZoneId[idx] = zoneId
      homeNode[idx] = homeNodeId
      returningHome[idx] = 0
      liveCount++
      added++
    }
    return added
  }

  // ──────────────────────────────────────────────────────────────────
  // Fire-truck spawn / tick / recall
  // ──────────────────────────────────────────────────────────────────

  function findFreeSlot() {
    for (let i = 0; i < capacity; i++) {
      if (!alive[i]) return i
    }
    return -1
  }

  // `targetArea` is the operator's search circle: { lat, lng, radius }. The
  // truck drives toward the circle's centre, then patrols inside it scanning
  // for smoke. A point-shaped {lat, lng} is accepted for back-compat and gets
  // a default radius of TRUCK_PATROL_RADIUS_M.
  function spawnFireTrucks(dispatchId, stationLoc, targetArea, n, _stationId) {
    if (!stationLoc || !targetArea) return 0
    const stationNodeId = roadGraph.findNearestNode(stationLoc.lat, stationLoc.lng)
    const stationNode = stationNodeId != null ? roadGraph.nodeLocation(stationNodeId) : null
    if (!stationNode) return 0
    const targetLat = targetArea.lat
    const targetLng = targetArea.lng
    const targetRadiusM = Math.max(50, +targetArea.radius || TRUCK_PATROL_RADIUS_M)
    const targetNodeId = roadGraph.findNearestNode(targetLat, targetLng)
    if (targetNodeId == null) return 0
    let added = 0
    while (added < n) {
      const idx = findFreeSlot()
      if (idx < 0) break
      // Reset the slot.
      lats[idx] = stationNode.lat
      lngs[idx] = stationNode.lng
      currentNode[idx] = stationNodeId
      prevNode[idx] = null
      causeZoneId[idx] = null
      recoveryAt[idx] = 0
      lastMovedSimT[idx] = simTimeS
      totalMovedM[idx] = 0
      retargetCount[idx] = 0
      lastRetargetSimT[idx] = simTimeS
      reportLog[idx].clear()
      linkedZoneId[idx] = null
      homeNode[idx] = null
      returningHome[idx] = 0
      // Truck-specific.
      kind[idx] = 1
      states[idx] = 'truck_driving'
      stateExpiresAt[idx] = Infinity
      truckRole[idx] = TRUCK_ROLE_EN_ROUTE
      truckTargetZoneId[idx] = null
      truckStationLat[idx] = stationNode.lat
      truckStationLng[idx] = stationNode.lng
      truckDispatchId[idx] = dispatchId
      truckPatrolNextAt[idx] = 0
      truckPerceptionNextAt[idx] = 0
      truckSearchLat[idx] = targetLat
      truckSearchLng[idx] = targetLng
      truckSearchRadiusM[idx] = targetRadiusM
      truckPatrolStartedAt[idx] = 0
      truckCapacity[idx] = FIRE_TRUCK_CAPACITY
      // Anchor stuck-check at the station so the first window doesn't
      // mis-classify the departing truck as stuck.
      stuckAnchorLat[idx] = stationNode.lat
      stuckAnchorLng[idx] = stationNode.lng
      stuckAnchorSimT[idx] = simTimeS
      alive[idx] = 1
      retarget(idx, targetNodeId)
      if (idx >= activeCount) activeCount = idx + 1
      liveCount++
      added++
    }
    return added
  }

  function recallTrucks(dispatchId) {
    let n = 0
    for (let i = 0; i < activeCount; i++) {
      if (!alive[i]) continue
      if (kind[i] !== 1) continue
      if (truckDispatchId[i] !== dispatchId) continue
      truckRole[i] = TRUCK_ROLE_RETURNING
      truckTargetZoneId[i] = null
      states[i] = 'truck_driving'
      const homeId = roadGraph.findNearestNode(truckStationLat[i], truckStationLng[i])
      if (homeId != null) retarget(i, homeId)
      n++
    }
    return n
  }

  // Find the closest fire-zone the truck can see right now. Reuses citizen
  // perception (visual + audible) scaled by severity. Returns the zone or null.
  function findVisibleFire(idx, zones) {
    let best = null
    let bestD = Infinity
    const myLat = lats[idx]
    const myLng = lngs[idx]
    for (const zone of zones) {
      if (zone.status !== 'active') continue
      if (zone.type !== 'Wildfire' && zone.type !== 'Building_Fire') continue
      if (zone.triggeredAt == null) continue
      const center = eventCenter(zone)
      if (!center) continue
      const d = distanceMeters(myLat, myLng, center.lat, center.lng)
      const { visual, audible } = getPerception(zone.type, zone.severity ?? 1)
      // Trucks are trained to look — give them a generous floor (250 m) even
      // when the type's nominal perception is small. Spreading wildfires are
      // visible from beyond their current perimeter (smoke plume), so widen
      // the reach with the live wave radius too.
      const waveR = zoneStates.get(zone.id)?.radius || 0
      const reach = Math.max(visual, audible, 250, waveR + 200)
      if (d <= reach && d < bestD) { best = zone; bestD = d }
    }
    return best
  }

  function tickFireTruck(idx, zoneIndex, zones, dtS) {
    const role = truckRole[idx]

    if (role === TRUCK_ROLE_EN_ROUTE) {
      // "Arrived" = inside the search circle (or path stalled). Trucks may
      // cross the perimeter from any angle; once inside they start patrolling.
      const dToCentre = distanceMeters(lats[idx], lngs[idx], truckSearchLat[idx], truckSearchLng[idx])
      const arrived = dToCentre <= truckSearchRadiusM[idx] || (path[idx] && path[idx].length < 2)
      if (arrived) {
        truckRole[idx] = TRUCK_ROLE_PATROLLING
        states[idx] = 'truck_patrolling'
        truckPatrolNextAt[idx] = simTimeS  // pick a target this tick
        truckPatrolStartedAt[idx] = simTimeS
      } else {
        advanceAlongPath(idx, dtS, zones)
      }
      return
    }

    if (role === TRUCK_ROLE_PATROLLING) {
      // Perception check first — if a fire is visible, switch to APPROACHING.
      if (simTimeS >= truckPerceptionNextAt[idx]) {
        truckPerceptionNextAt[idx] = simTimeS + 1.5
        const fire = findVisibleFire(idx, zones)
        if (fire) {
          truckTargetZoneId[idx] = fire.id
          truckRole[idx] = TRUCK_ROLE_APPROACHING
          states[idx] = 'truck_driving'
          const c = eventCenter(fire)
          const nearId = c ? roadGraph.findNearestNode(c.lat, c.lng) : null
          if (nearId != null) retarget(idx, nearId)
          return
        }
      }
      // Auto-return safety net: if we've been patrolling for too long without
      // perceiving any fire, the operator's circle is probably empty — head
      // home rather than wandering forever.
      if (simTimeS - truckPatrolStartedAt[idx] > 90) {
        truckRole[idx] = TRUCK_ROLE_RETURNING
        states[idx] = 'truck_driving'
        const hid = roadGraph.findNearestNode(truckStationLat[idx], truckStationLng[idx])
        if (hid != null) retarget(idx, hid)
        return
      }
      // Patrol — pick a uniformly-random point inside the search circle every
      // 6 sim-seconds, or when the current path runs out. `sqrt(rand) * R`
      // gives a uniform area distribution (vs. clustering near the centre).
      if (simTimeS >= truckPatrolNextAt[idx] || !path[idx] || path[idx].length < 2) {
        truckPatrolNextAt[idx] = simTimeS + 6
        const angle = Math.random() * Math.PI * 2
        const r = Math.sqrt(Math.random()) * truckSearchRadiusM[idx]
        const offLat = (Math.sin(angle) * r) / 111111
        const offLng = (Math.cos(angle) * r) / (111111 * Math.cos((truckSearchLat[idx] * Math.PI) / 180))
        const nid = roadGraph.findNearestNode(truckSearchLat[idx] + offLat, truckSearchLng[idx] + offLng)
        if (nid != null) retarget(idx, nid)
      }
      advanceAlongPath(idx, dtS, zones)
      return
    }

    if (role === TRUCK_ROLE_APPROACHING) {
      const tgt = zones.find((z) => z.id === truckTargetZoneId[idx])
      if (!tgt) {
        // Target vanished (extinguished elsewhere) — recall.
        truckRole[idx] = TRUCK_ROLE_RETURNING
        truckTargetZoneId[idx] = null
        states[idx] = 'truck_driving'
        const hid = roadGraph.findNearestNode(truckStationLat[idx], truckStationLng[idx])
        if (hid != null) retarget(idx, hid)
        return
      }
      const c = eventCenter(tgt)
      if (c) {
        const d = distanceMeters(lats[idx], lngs[idx], c.lat, c.lng)
        // Start fighting when the truck crosses the dashed wave perimeter
        // (zoneStates radius is the same value WaveLayer draws). Building
        // fires have no zoneStates entry, so reach falls back to the fixed
        // 60 m close-approach distance.
        const waveR = zoneStates.get(truckTargetZoneId[idx])?.radius || 0
        const reach = Math.max(waveR, TRUCK_EXTINGUISH_REACH_M)
        if (d <= reach) {
          truckRole[idx] = TRUCK_ROLE_EXTINGUISHING
          states[idx] = 'truck_extinguishing'
          return
        }
        // Re-target if our path ran out short of the fire (e.g. spawned in
        // a node that didn't have a direct BFS, or the fire moved).
        if (!path[idx] || path[idx].length < 2) {
          const nid = roadGraph.findNearestNode(c.lat, c.lng)
          if (nid != null) retarget(idx, nid)
        }
      }
      advanceAlongPath(idx, dtS, zones)
      return
    }

    if (role === TRUCK_ROLE_EXTINGUISHING) {
      // Contribute to fightRate. The wave / building integrator above this
      // loop (next tick onward) reads it.
      const zid = truckTargetZoneId[idx]
      if (zid) {
        fightRate.set(zid, (fightRate.get(zid) || 0) + truckCapacity[idx])
      }
      // No movement.
      return
    }

    if (role === TRUCK_ROLE_RETURNING) {
      const dToStation = distanceMeters(lats[idx], lngs[idx], truckStationLat[idx], truckStationLng[idx])
      if (dToStation < 30) {
        // Arrived — despawn the truck.
        alive[idx] = 0
        lats[idx] = NaN
        lngs[idx] = NaN
        kind[idx] = 0
        truckRole[idx] = 0
        truckTargetZoneId[idx] = null
        truckDispatchId[idx] = null
        liveCount--
        return
      }
      // Ensure we have a path home; if BFS bailed earlier, re-try.
      if (!path[idx] || path[idx].length < 2) {
        const hid = roadGraph.findNearestNode(truckStationLat[idx], truckStationLng[idx])
        if (hid != null) retarget(idx, hid)
      }
      advanceAlongPath(idx, dtS, zones)
      return
    }
  }

  // Set of dispatch ids with at least one alive truck. The dashboard polls
  // this to prune the "Active dispatches" UI list when every truck in a
  // dispatch has either despawned at home or been recalled — otherwise the
  // entry sticks around forever even though the trucks are long gone.
  function getActiveDispatchIds() {
    const ids = new Set()
    for (let i = 0; i < activeCount; i++) {
      if (!alive[i] || kind[i] !== 1) continue
      const did = truckDispatchId[i]
      if (did) ids.add(did)
    }
    return ids
  }

  return {
    start, stop, setSpeed, tick, snapshot,
    getZoneWaves, getCitizenStats, getCurrentTime,
    spawnFleeingCitizens, spawnFireTrucks, recallTrucks, getActiveDispatchIds, subscribe,
  }
}
