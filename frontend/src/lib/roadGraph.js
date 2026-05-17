// Road graph fetched from OSM via Overpass, parsed into an adjacency map.
// Used by the citizen simulation so dots walk on streets rather than through
// buildings and rivers. Cached in localStorage so the ~5–15 s Overpass round
// trip only hits on first launch.

const CACHE_KEY = 'sentinel-roadgraph-v4'
const CACHE_VERSION = 4
// Anything walkable. Excludes motorways/trunks (no pedestrians) and footways
// (we want street-edge density, not parks/trails).
const HIGHWAY_TYPES = [
  'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street', 'service',
  'primary_link', 'secondary_link', 'tertiary_link',
]

function shuffleCopy(arr) {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

function distanceMeters(latA, lngA, latB, lngB) {
  const R = 6378137
  const dLat = ((latB - latA) * Math.PI) / 180
  const dLng = ((lngB - lngA) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((latA * Math.PI) / 180) *
      Math.cos((latB * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function buildOverpassQuery(bounds) {
  const [[s, w], [n, e]] = bounds
  const highwayRegex = HIGHWAY_TYPES.join('|')
  return (
    `[out:json][timeout:60];` +
    `way["highway"~"^(${highwayRegex})$"](${s},${w},${n},${e});` +
    `out tags geom;`
  )
}

async function fetchRoadsFromOverpass(bounds, signal) {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: buildOverpassQuery(bounds),
    signal,
  })
  if (!res.ok) throw new Error(`Overpass ${res.status}`)
  return res.json()
}

// Ray-cast point-in-polygon. Accepts a GeoJSON Polygon (uses outer ring only).
function pointInPolygon(lng, lat, polygon) {
  if (!polygon || polygon.type !== 'Polygon') return true
  const ring = polygon.coordinates[0]
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

// Convert an Overpass "way with geom" response into:
//   nodes: Map<nodeId, { lat, lng }>
//   edges: Map<nodeId, Array<{ to: nodeId, length_m: number }>>
//   nodeIds: number[]
//
// OSM `out geom;` returns each way's full geometry but not individual node ids
// for interior points. We synthesize node ids from (lat,lng) rounded to ~1m
// precision so two ways that share a junction collapse to a single node.
//
// If `polygon` is provided, nodes outside it (and edges that reference them)
// are dropped — this is how we keep the citizen sim from spawning across the
// Hudson into New Jersey or across the East River into Brooklyn.
function buildGraph(elements, polygon) {
  const nodes = new Map()
  const edges = new Map()

  const keyOf = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`
  const nodeIdOf = (lat, lng) => {
    const k = keyOf(lat, lng)
    if (nodes.has(k)) return k
    nodes.set(k, { lat, lng })
    edges.set(k, [])
    return k
  }

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const isOneway = el.tags?.oneway === 'yes' || el.tags?.oneway === 'true' || el.tags?.oneway === '1'
    for (let i = 0; i < el.geometry.length - 1; i++) {
      const a = el.geometry[i]
      const b = el.geometry[i + 1]
      const aId = nodeIdOf(a.lat, a.lon)
      const bId = nodeIdOf(b.lat, b.lon)
      if (aId === bId) continue
      const len = distanceMeters(a.lat, a.lon, b.lat, b.lon)
      edges.get(aId).push({ to: bId, length_m: len })
      if (!isOneway) edges.get(bId).push({ to: aId, length_m: len })
    }
  }

  // If a polygon filter was supplied, drop nodes outside it and any edges that
  // crossed the boundary.
  if (polygon) {
    const keep = new Set()
    for (const [id, loc] of nodes) {
      if (pointInPolygon(loc.lng, loc.lat, polygon)) keep.add(id)
    }
    for (const id of [...nodes.keys()]) {
      if (!keep.has(id)) {
        nodes.delete(id)
        edges.delete(id)
      }
    }
    for (const [id, list] of edges) {
      edges.set(id, list.filter((e) => keep.has(e.to)))
    }
  }

  // Keep only the largest connected component. Polygon-filtering can leave
  // small isolated clusters near the boundary (bridge stubs, dead-end streets
  // whose only neighbors got clipped). Citizens spawned in those clusters
  // can't reach the main grid via BFS and end up oscillating in place.
  keepLargestComponent(nodes, edges)

  // Trim isolated nodes (any edge endpoint should still be present).
  const nodeIds = [...nodes.keys()].filter((id) => (edges.get(id) || []).length > 0)
  return { nodes, edges, nodeIds }
}

function keepLargestComponent(nodes, edges) {
  const visited = new Set()
  let largest = null
  for (const startId of nodes.keys()) {
    if (visited.has(startId)) continue
    // BFS this component.
    const component = new Set()
    const queue = [startId]
    while (queue.length) {
      const cur = queue.shift()
      if (component.has(cur)) continue
      component.add(cur)
      visited.add(cur)
      for (const e of edges.get(cur) || []) {
        if (!component.has(e.to)) queue.push(e.to)
      }
    }
    if (!largest || component.size > largest.size) largest = component
  }
  if (!largest) return
  for (const id of [...nodes.keys()]) {
    if (!largest.has(id)) {
      nodes.delete(id)
      edges.delete(id)
    }
  }
  for (const [id, list] of edges) {
    edges.set(id, list.filter((e) => largest.has(e.to)))
  }
}

function cacheSignature(bounds, polygon) {
  return JSON.stringify({ bounds, polygon: polygon || null })
}

function readCache(bounds, polygon) {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed.version !== CACHE_VERSION) return null
    if (parsed.signature !== cacheSignature(bounds, polygon)) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(bounds, polygon, graph) {
  try {
    // Convert Maps to plain objects for JSON serialization.
    const nodesObj = {}
    for (const [k, v] of graph.nodes) nodesObj[k] = v
    const edgesObj = {}
    for (const [k, v] of graph.edges) edgesObj[k] = v
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: CACHE_VERSION,
        signature: cacheSignature(bounds, polygon),
        nodes: nodesObj,
        edges: edgesObj,
        nodeIds: graph.nodeIds,
      }),
    )
  } catch {
    /* localStorage may be full; skipping cache is harmless */
  }
}

function hydrateCache(parsed) {
  const nodes = new Map(Object.entries(parsed.nodes))
  const edges = new Map(Object.entries(parsed.edges))
  return { nodes, edges, nodeIds: parsed.nodeIds }
}

const NODE_INDEX_SCALE = 1000 // ~110m × 110m buckets at the equator

export class RoadGraph {
  constructor({ nodes, edges, nodeIds }) {
    this.nodes = nodes
    this.edges = edges
    this.nodeIds = nodeIds
    // Precompute a flat lat/lng grid index over all nodes so we can look
    // up the nearest node to an arbitrary point cheaply. Done once at load.
    this.nodeIndex = new Map()
    for (const id of nodeIds) {
      const loc = nodes.get(id)
      if (!loc) continue
      const key = `${Math.floor(loc.lat * NODE_INDEX_SCALE)}|${Math.floor(loc.lng * NODE_INDEX_SCALE)}`
      let bucket = this.nodeIndex.get(key)
      if (!bucket) {
        bucket = []
        this.nodeIndex.set(key, bucket)
      }
      bucket.push(id)
    }
  }

  size() {
    return this.nodeIds.length
  }

  getRandomNode() {
    return this.nodeIds[Math.floor(Math.random() * this.nodeIds.length)]
  }

  nodeLocation(id) {
    return this.nodes.get(id)
  }

  // Returns the neighbors of a node as [{ to, length_m }, ...].
  neighbors(id) {
    return this.edges.get(id) || []
  }

  // Yield all node ids whose location falls inside the given lat/lng bbox.
  // Uses the spatial bucket index so we don't have to scan all ~37k nodes.
  // Caller is expected to apply a precise per-node shape test afterwards.
  nodeIdsInBbox(latMin, latMax, lngMin, lngMax, out = []) {
    const minLatB = Math.floor(latMin * NODE_INDEX_SCALE)
    const maxLatB = Math.floor(latMax * NODE_INDEX_SCALE)
    const minLngB = Math.floor(lngMin * NODE_INDEX_SCALE)
    const maxLngB = Math.floor(lngMax * NODE_INDEX_SCALE)
    for (let la = minLatB; la <= maxLatB; la++) {
      for (let ln = minLngB; ln <= maxLngB; ln++) {
        const bucket = this.nodeIndex.get(`${la}|${ln}`)
        if (bucket) for (const id of bucket) out.push(id)
      }
    }
    return out
  }

  // Find the node closest to a given (lat, lng). Searches in concentric
  // square rings centred on the target's bucket; returns as soon as any
  // bucket yields a candidate (which is then refined by checking the
  // remaining cells in that ring before returning).
  findNearestNode(lat, lng) {
    const baseLat = Math.floor(lat * NODE_INDEX_SCALE)
    const baseLng = Math.floor(lng * NODE_INDEX_SCALE)
    let best = null
    let bestSqDist = Infinity

    const check = (dl, dln) => {
      const bucket = this.nodeIndex.get(`${baseLat + dl}|${baseLng + dln}`)
      if (!bucket) return
      for (const id of bucket) {
        const loc = this.nodes.get(id)
        const dLat = loc.lat - lat
        const dLng = loc.lng - lng
        const sq = dLat * dLat + dLng * dLng
        if (sq < bestSqDist) { bestSqDist = sq; best = id }
      }
    }

    // radius 0 first (the centre bucket), then expanding rings.
    check(0, 0)
    if (best) return best
    for (let radius = 1; radius <= 12; radius++) {
      for (let dl = -radius; dl <= radius; dl++) {
        for (let dln = -radius; dln <= radius; dln++) {
          // Only the OUTER ring at this radius.
          if (Math.max(Math.abs(dl), Math.abs(dln)) !== radius) continue
          check(dl, dln)
        }
      }
      if (best) return best
    }
    return best
  }

  // Bounded BFS — exploration budget is high enough to traverse all of
  // Manhattan's road graph (~39k nodes), so any reachable target succeeds.
  // BFS still bails on unreachable targets (e.g. isolated subgraphs).
  //
  // Neighbor order is randomised per visit so BFS picks a varied shortest
  // path among ties instead of always returning the same L-shape. Without
  // this, every citizen routed across Manhattan's grid follows the same
  // "all-east then all-north" path — they visually appear to refuse turns
  // because the adjacency list always lists "continue down this street"
  // before "turn onto the cross street" (insertion order matches OSM way
  // order). Shuffling is cheap (~4 neighbors per node) and only adds
  // variety; hop count is unchanged.
  bfs(fromId, toId, exploreBudget = 50000) {
    if (fromId === toId) return [fromId]
    const prev = new Map()
    prev.set(fromId, null)
    const queue = [fromId]
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      if (cur === toId) break
      if (prev.size > exploreBudget) break
      const ns = this.neighbors(cur)
      const order = ns.length > 1 ? shuffleCopy(ns) : ns
      for (const e of order) {
        if (prev.has(e.to)) continue
        prev.set(e.to, cur)
        queue.push(e.to)
      }
    }
    if (!prev.has(toId)) return null
    const path = []
    let n = toId
    while (n !== null) {
      path.push(n)
      n = prev.get(n)
    }
    path.reverse()
    return path
  }
}

// Public entry point. `onProgress(label)` lets the UI show "Loading street network…"
// while the fetch + parse runs (~5–15 s cold, instant warm).
// If `polygon` is supplied, road-graph nodes outside it are dropped — used to
// keep the citizen sim from spawning across rivers into neighboring areas.
export async function loadRoadGraph(bounds, { signal, polygon = null, onProgress } = {}) {
  const cached = readCache(bounds, polygon)
  if (cached) {
    onProgress?.('Restoring street network from cache…')
    return new RoadGraph(hydrateCache(cached))
  }

  onProgress?.('Fetching street network from OpenStreetMap…')
  const raw = await fetchRoadsFromOverpass(bounds, signal)
  onProgress?.(`Parsing ${raw.elements?.length || 0} ways…`)
  const graph = buildGraph(raw.elements || [], polygon)
  writeCache(bounds, polygon, graph)
  onProgress?.(`Ready — ${graph.nodeIds.length} street nodes.`)
  return new RoadGraph(graph)
}
