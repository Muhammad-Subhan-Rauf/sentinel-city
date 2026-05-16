// ─── Routing helper for self-hosted Valhalla ───────────────────
// Targets a local Valhalla server (defaults to http://localhost:8002).
// Override via VITE_VALHALLA_URL in .env.

const VALHALLA_URL = import.meta.env.VITE_VALHALLA_URL ?? '/valhalla'

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

// Convert a circle zone (Point + radius) into a closed polygon ring of
// [[lng, lat], ...] suitable for Valhalla's avoid_polygons.
function circleZoneToRing(zone, segments = 36) {
  const [lng, lat] = zone.geometry.coordinates
  const radius = zone.geometry.radius_metres
  const earthRadius = 6378137 // metres
  const ring = []
  const latRad = (lat * Math.PI) / 180
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    const dLat = (radius * Math.cos(angle)) / earthRadius
    const dLng = (radius * Math.sin(angle)) / (earthRadius * Math.cos(latRad))
    ring.push([
      lng + (dLng * 180) / Math.PI,
      lat + (dLat * 180) / Math.PI,
    ])
  }
  return ring
}

// Build Valhalla's avoid_polygons payload from the dashboard's zones array.
// Polygons contribute their outer ring; circles get tessellated.
export function zonesToAvoidPolygons(zones) {
  return zones
    .map((z) => {
      if (!z?.geometry) return null
      if (z.geometry.type === 'Polygon') {
        return z.geometry.coordinates[0]
      }
      if (z.geometry.type === 'Point' && z.geometry.radius_metres) {
        return circleZoneToRing(z)
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
  if (avoid.length > 0) body.avoid_polygons = avoid

  const res = await fetch(`${VALHALLA_URL}/route`, {
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
