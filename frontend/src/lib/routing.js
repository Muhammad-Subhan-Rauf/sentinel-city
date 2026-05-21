// ─── Routing helper (Stadia Maps Valhalla) ─────────────────────
// Targets Stadia's hosted Valhalla service. Override via VITE_VALHALLA_URL
// + VITE_STADIA_API_KEY in .env. The API key is appended as a query param
// on the route call — it'll be visible in the bundle (Stadia's standard
// client-side model), so don't reuse this key for anything sensitive.

import { getBlockingRadius } from './disasterProfiles'

const VALHALLA_URL = import.meta.env.VITE_VALHALLA_URL ?? 'https://api.stadiamaps.com'
const STADIA_API_KEY = import.meta.env.VITE_STADIA_API_KEY ?? ''

// Decode a Valhalla polyline (precision 6 by default — Valhalla uses polyline6).
export function decodePolyline(encoded, precision = 6) {
  const factor = Math.pow(10, precision)
  let index = 0
  let lat = 0
  let lng = 0
  const coords = []
  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let b
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlat = result & 1 ? ~(result >> 1) : result >> 1
    lat += dlat

    result = 0
    shift = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlng = result & 1 ? ~(result >> 1) : result >> 1
    lng += dlng

    coords.push([lat / factor, lng / factor])
  }
  return coords
}

// Convert a point + radius into a closed polygon ring of [[lng, lat], ...].
function pointToRing(lng, lat, radiusM, segments = 36) {
  const earthRadius = 6378137 // metres
  const latRad = (lat * Math.PI) / 180
  const ring = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    const dLat = (radiusM * Math.cos(angle)) / earthRadius
    const dLng = (radiusM * Math.sin(angle)) / (earthRadius * Math.cos(latRad))
    ring.push([
      lng + (dLng * 180) / Math.PI,
      lat + (dLat * 180) / Math.PI,
    ])
  }
  return ring
}

// Build Valhalla's avoid_polygons payload from the dashboard's zones array.
// The profile's `blockingRadius` is the source of truth:
//   - `0`                     → event does not block traffic (Heatwave, Power_Outage, sev-1 Robbery, …)
//   - `'use_drawn_geometry'`  → the operator-drawn polygon/circle is the block (Flood, Wildfire)
//   - number                  → point event, buffer by N metres into a circular block (Accident, Gang_Violence, …)
// Citywide events always return 0 by profile, so they're filtered here.
export function zonesToAvoidPolygons(zones) {
  return zones
    .map((z) => {
      if (!z) return null
      const blockSpec = getBlockingRadius(z.type, z.severity ?? 1)

      // Profile explicitly says this event type doesn't block roads.
      if (blockSpec === 0) return null

      // Profile says: use whatever the operator drew.
      if (blockSpec === 'use_drawn_geometry') {
        if (!z.geometry) return null
        if (z.geometry.type === 'Polygon') return z.geometry.coordinates[0]
        if (z.geometry.type === 'Point' && z.geometry.radius_metres) {
          const [lng, lat] = z.geometry.coordinates
          return pointToRing(lng, lat, z.geometry.radius_metres)
        }
        return null
      }

      // Profile says: buffer a point by this radius (in metres).
      if (typeof blockSpec === 'number' && blockSpec > 0) {
        if (z.geometry?.type === 'Point') {
          const [lng, lat] = z.geometry.coordinates
          return pointToRing(lng, lat, blockSpec)
        }
        // Falls through if a non-point type somehow has a numeric block radius —
        // shouldn't happen with current profiles, but be defensive.
        return null
      }

      return null
    })
    .filter(Boolean)
}

// Issue a route request to Valhalla. Returns { shape, distanceMeters, durationSeconds }.
export async function requestRoute({ start, end, zones = [], signal }) {
  if (!start || !end) throw new Error('Both start and end waypoints are required.')

  const body = {
    locations: [
      { lat: start.lat, lon: start.lng, type: 'break' },
      { lat: end.lat, lon: end.lng, type: 'break' },
    ],
    costing: 'auto',
    costing_options: {
      auto: {
        // Prefer geographically shorter routes over fastest-by-time.
        // 1.0 = pure distance, 0.0 = pure time (default).
        use_distance: 1.0,
        // Discourage highway usage so the route is willing to exit onto
        // surface streets when doing so is shorter. 0 = avoid, 1 = prefer.
        use_highways: 0.2,
      },
    },
    directions_options: { units: 'kilometers' },
  }
  const avoid = zonesToAvoidPolygons(zones)
  if (avoid.length > 0) body.exclude_polygons = avoid

  const res = await fetch(`${VALHALLA_URL}/route/v1?api_key=${STADIA_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const err = await res.json()
      detail = err.error || err.message || detail
    } catch { /* ignore parse error */ }
    throw new Error(`Routing failed: ${detail}`)
  }

  const data = await res.json()
  // Valhalla concatenates leg shapes; we have a single leg (start → end).
  const leg = data?.trip?.legs?.[0]
  if (!leg) throw new Error('No route returned')

  return {
    shape: decodePolyline(leg.shape, 6),
    distanceMeters: (data.trip.summary?.length || leg.summary?.length || 0) * 1000,
    durationSeconds: data.trip.summary?.time || leg.summary?.time || 0,
  }
}
