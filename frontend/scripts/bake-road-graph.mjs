// Bake the Manhattan road graph to a static JSON so the runtime doesn't have
// to depend on Overpass during a demo. Re-run this when CACHE_VERSION bumps
// in src/lib/roadGraph.js or when the city polygon changes.
//
//   node scripts/bake-road-graph.mjs
//
// Writes to frontend/public/road-graph-<slug>.json. loadRoadGraph fetches it
// at startup; on miss it falls back to a live Overpass query.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGraph } from '../src/lib/roadGraph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HIGHWAY_TYPES = [
  'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street', 'service',
  'primary_link', 'secondary_link', 'tertiary_link',
]

// Mirror of DEFAULT_CITY in DisasterDashboard.jsx. If you change one, change
// the other — the polygon is the source of truth for which nodes survive the
// "drop everything outside the island" filter.
const CITIES = {
  manhattan: {
    slug: 'manhattan',
    bounds: [
      [40.6815, -74.0479],
      [40.8820, -73.9070],
    ],
    polygon: {
      type: 'Polygon',
      coordinates: [[
        [-73.923, 40.879],
        [-73.911, 40.864],
        [-73.928, 40.835],
        [-73.929, 40.810],
        [-73.937, 40.795],
        [-73.948, 40.781],
        [-73.958, 40.764],
        [-73.965, 40.752],
        [-73.969, 40.738],
        [-73.972, 40.726],
        [-73.971, 40.711],
        [-73.999, 40.701],
        [-74.018, 40.701],
        [-74.014, 40.717],
        [-74.011, 40.733],
        [-74.010, 40.752],
        [-74.001, 40.769],
        [-73.992, 40.781],
        [-73.980, 40.799],
        [-73.968, 40.811],
        [-73.953, 40.835],
        [-73.944, 40.849],
        [-73.933, 40.864],
        [-73.923, 40.879],
      ]],
    },
  },
}

// Try a primary endpoint plus a couple of public mirrors so a flaky one
// doesn't kill the bake.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

function buildOverpassQuery(bounds) {
  const [[s, w], [n, e]] = bounds
  const highwayRegex = HIGHWAY_TYPES.join('|')
  return (
    `[out:json][timeout:90];` +
    `way["highway"~"^(${highwayRegex})$"](${s},${w},${n},${e});` +
    `out tags geom;`
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchOverpass(query) {
  // Overpass expects `data=<urlencoded>` with x-www-form-urlencoded. Sending
  // the raw query string with no Content-Type makes some endpoints return
  // 406 Not Acceptable.
  const body = `data=${encodeURIComponent(query)}`
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'sentinel-city-bake/1.0 (hackathon)',
  }
  // Two passes: if every mirror is rate-limited (429), wait a bit then try again.
  let lastErr = null
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      const waitMs = 5000 * pass
      console.log(`  every mirror busy — waiting ${waitMs / 1000}s before retry…`)
      await sleep(waitMs)
    }
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        console.log(`  fetching ${url}…`)
        const res = await fetch(url, { method: 'POST', headers, body })
        if (!res.ok) {
          console.log(`  ${url} → ${res.status}, trying next mirror`)
          lastErr = new Error(`Overpass ${res.status}`)
          continue
        }
        return await res.json()
      } catch (err) {
        console.log(`  ${url} → ${err.message}, trying next mirror`)
        lastErr = err
      }
    }
  }
  throw lastErr ?? new Error('All Overpass endpoints failed')
}

async function bake(cityKey) {
  const city = CITIES[cityKey]
  if (!city) throw new Error(`Unknown city: ${cityKey}`)
  console.log(`Baking road graph for ${cityKey}…`)
  const json = await fetchOverpass(buildOverpassQuery(city.bounds))
  const ways = json.elements?.length ?? 0
  console.log(`  Overpass returned ${ways} ways`)

  const graph = buildGraph(json.elements, city.polygon)
  console.log(`  built graph: ${graph.nodeIds.length} nodes`)

  // Serialise in the same shape `hydrateCache` expects, so loadRoadGraph can
  // hand the parsed JSON straight to the RoadGraph constructor.
  const nodesObj = {}
  for (const [k, v] of graph.nodes) nodesObj[k] = v
  const edgesObj = {}
  for (const [k, v] of graph.edges) edgesObj[k] = v
  const payload = { nodes: nodesObj, edges: edgesObj, nodeIds: graph.nodeIds }

  const outPath = path.resolve(__dirname, '..', 'public', `road-graph-${city.slug}.json`)
  await fs.writeFile(outPath, JSON.stringify(payload))
  const stat = await fs.stat(outPath)
  console.log(`  wrote ${outPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
}

const cityArg = process.argv[2] || 'manhattan'
await bake(cityArg)
