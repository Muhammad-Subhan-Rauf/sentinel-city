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
  getZones,
  onReport,
}) {
  // Per-citizen state, parallel arrays for hot loop access.
  const lats = new Float32Array(count)
  const lngs = new Float32Array(count)
  const currentNode = new Array(count)
  const targetNode = new Array(count)
  const path = new Array(count)          // remaining node sequence
  const states = new Array(count)
  const stateExpiresAt = new Float32Array(count)
  // The zone id that put a citizen into their current reactive state.
  // Used to detect when the originating disaster is removed so we can
  // gradually return citizens to normal walking.
  const causeZoneId = new Array(count).fill(null)
  // simTimeS at which an orphaned reactive citizen returns to walking.
  // 0 = not in recovery yet.
  const recoveryAt = new Float32Array(count)
  // Last node the citizen passed through. Used by the random-walk picker so
  // calm walkers don't immediately reverse direction at every intersection.
  const prevNode = new Array(count).fill(null)
  // Nodes that fall inside an active area hazard. Rebuilt each tick from the
  // current zone list. Walking citizens refuse to step onto these so they
  // don't wander back into a wildfire / flood polygon after their flee state
  // has expired. Re-entering would re-trigger fleeing, producing the
  // oscillating "leave then come back and hit the area" behaviour.
  const hazardNodeSet = new Set()
  // Map<eventId, lastReportT_seconds> per citizen
  const reportLog = Array.from({ length: count }, () => new Map())
  // Per-zone time-based state for hazards with `spreads: true`. Populated
  // lazily the first time we see a zone; pruned when the zone disappears.
  //   zoneId → { startTime, centroid: { lat, lng }, maxRadius, spreadTime }
  const zoneStates = new Map()

  // Debug telemetry: per-citizen movement & retarget counters so the click-
  // to-inspect overlay can answer "is this citizen actually moving?".
  const lastMovedSimT = new Float32Array(count)
  const totalMovedM = new Float32Array(count)
  const retargetCount = new Uint32Array(count)
  const lastRetargetSimT = new Float32Array(count)

  let simTimeS = 0
  let tickHandle = null
  const listeners = new Set()

  // Pick the next hop for a citizen wandering at random. Prefers neighbors
  // that are (a) not inside a hazard zone and (b) not the one they just came
  // from, so calm walkers don't drift back into a wildfire or bounce in
  // place. Falls back gracefully if every neighbor is hazardous (e.g. a
  // citizen who was just released from fleeing while still surrounded by
  // hazard nodes).
  function pickRandomWalkNext(currentId, avoidId) {
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
      const nextId = pickRandomWalkNext(currentNode[idx], prevNode[idx])
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
      retargetForState(idx, zones)
      return
    }
    const speed = SPEED_MPS[states[idx]] ?? SPEED_MPS.walking
    if (speed <= 0) return

    const startLat = lats[idx]
    const startLng = lngs[idx]

    let remaining = speed * dtS
    while (remaining > 0 && p.length >= 2) {
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
      retargetForState(idx, zones)
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
      startTime: simTimeS,
      centroid,
      maxRadius,
      // Spread rate in sim-meters-per-sim-second.
      spreadRate: profile.spreadRateMps?.(zone.severity ?? 1) || 3,
      color: profile.color || '#3b82f6',
      type: zone.type,
      severity: zone.severity ?? 1,
    }
    zoneStates.set(zone.id, s)
    return s
  }

  function currentWaveRadius(state) {
    const elapsed = Math.max(0, simTimeS - state.startTime)
    return Math.min(state.maxRadius, elapsed * state.spreadRate)
  }

  function reactToEvent(idx, zone, kind) {
    const profile = getProfile(zone.type)
    if (!profile) return
    // Citywide events have no center, so fleeing/approaching directions are
    // meaningless — those response modes degrade to a neutral shelter state.
    const ec = eventCenter(zone)

    const response = profile.citizenResponse
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

      // Observation area zones (Flood, Wildfire): citizens inside, OR within
      // the perception buffer just outside the polygon, fire an observation
      // report and transition to fleeing. For spreading hazards we extend the
      // perception reach by the polygon's maxRadius so the centroid-distance
      // check is effectively "distance to polygon edge ≤ visual perception"
      // — without that, citizens at a polygon's edge wouldn't perceive it
      // since they're maxRadius away from the centroid.
      const center = eventCenter(zone)
      if (!center) continue
      const inside = isCitizenInsideZone(lats[idx], lngs[idx], zone)
      const d = inside ? 0 : distanceMeters(lats[idx], lngs[idx], center.lat, center.lng)
      const { visual, audible } = getPerception(zone.type, zone.severity ?? 1)
      let reach = Math.max(visual, audible)
      if (profile.spreads && reach > 0) {
        reach += maxRadiusFromCentroid(zone.geometry, center)
      }
      if (inside || (reach > 0 && d <= reach)) {
        maybeReport(idx, zone, 'observation')
        return
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
    for (let i = 0; i < count; i++) {
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
    const zoneIndex = buildZoneIndex(zones)
    const activeIds = new Set(zones.map((z) => z.id))
    const fainted = buildFaintedList()
    rebuildHazardSet(zones)

    // Drop wave state for zones that have been removed.
    for (const id of zoneStates.keys()) {
      if (!activeIds.has(id)) zoneStates.delete(id)
    }

    for (let i = 0; i < count; i++) {
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
    return { lats, lngs, states, count }
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
    if (idx < 0 || idx >= count) return null
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

  return { start, stop, setSpeed, tick, snapshot, getZoneWaves, getCitizenStats, subscribe }
}
