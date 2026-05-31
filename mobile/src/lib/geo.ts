// Pure geo helpers — kept dependency-free so they can be reused on any platform.

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(x));
}

export const KM_20_M = 20_000;

export function isWithin(meters: number, of: LatLng, target: LatLng): boolean {
  return haversineMeters(of, target) <= meters;
}

// Ray-cast point-in-polygon. `ring` is a closed GeoJSON ring of [lng, lat] pairs.
// Returns true if `point` is inside the polygon. Edge points are not guaranteed.
export function pointInPolygon(point: LatLng, ring: Array<[number, number]>): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  const x = point.lng;
  const y = point.lat;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Approximate the danger footprint of a disaster as a closed GeoJSON ring
// of [lng, lat] pairs. For Polygon geometries we return the outer ring
// directly. For Point geometries — which is how the operator dashboard saves
// point-type disasters like Wildfire/Flood with a single click — we synthesise
// a circle around the point whose radius scales with severity. Severity 1 ≈
// 280 m, severity 10 ≈ 1000 m. Used for map rendering, route avoidance, and
// "am I inside?" point-in-polygon tests so all three stay consistent.
export function disasterRing(
  geometry: any,
  severity: number | null | undefined,
): Array<[number, number]> {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return geometry.coordinates?.[0] ?? [];
  }
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    const sev = Math.max(1, Math.min(10, severity ?? 1));
    const radiusM = 200 + sev * 80;
    return circleRing({ lat, lng }, radiusM);
  }
  return [];
}

// Build a circular ring of [lng, lat] points around a centre. `radiusM` is
// metres; `steps` controls vertex density. Used both for visualising Point
// disasters as circles and for emergency-shrinking oversized polygons to
// something Valhalla will accept.
export function circleRing(
  centre: LatLng,
  radiusM: number,
  steps = 36,
): Array<[number, number]> {
  const latRad = (centre.lat * Math.PI) / 180;
  const mPerDegLat = 110_540;
  const mPerDegLng = 111_320 * Math.cos(latRad);
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    const dx = radiusM * Math.cos(a);
    const dy = radiusM * Math.sin(a);
    out.push([centre.lng + dx / mPerDegLng, centre.lat + dy / mPerDegLat]);
  }
  return out;
}

// A lat/lng bounding box (closed interval on both axes).
export type Bbox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

// Build a bbox around the [start, end] segment expanded by `marginM` metres in
// every direction. Used to scope avoid_polygons to only those that could
// plausibly intersect a route — at city-wide hazard scale we can't dump every
// polygon on Valhalla (it caps avoid_polygons count + per-polygon perimeter).
export function routeCorridorBbox(start: LatLng, end: LatLng, marginM: number): Bbox {
  const midLat = (start.lat + end.lat) / 2;
  const latDeg = marginM / 110_540;
  const lngDeg = marginM / (111_320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
  return {
    minLat: Math.min(start.lat, end.lat) - latDeg,
    maxLat: Math.max(start.lat, end.lat) + latDeg,
    minLng: Math.min(start.lng, end.lng) - lngDeg,
    maxLng: Math.max(start.lng, end.lng) + lngDeg,
  };
}

// Axis-aligned bbox of a [lng, lat] ring.
export function ringBbox(ring: Array<[number, number]>): Bbox {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  return !(a.maxLng < b.minLng || a.minLng > b.maxLng || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

// Centroid of a [lng, lat] ring (simple average — fine for distance ranking).
export function ringCentroid(ring: Array<[number, number]>): LatLng {
  let sLat = 0, sLng = 0;
  for (const [lng, lat] of ring) { sLat += lat; sLng += lng; }
  return { lat: sLat / ring.length, lng: sLng / ring.length };
}

// Perimeter of a [lng, lat] ring, in metres. Used to enforce Valhalla's 10 km
// avoid_polygons cap.
export function ringPerimeterMeters(ring: Array<[number, number]>): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a: LatLng = { lng: ring[i][0], lat: ring[i][1] };
    const b: LatLng = { lng: ring[i + 1][0], lat: ring[i + 1][1] };
    total += haversineMeters(a, b);
  }
  return total;
}

// Valhalla rejects avoid polygons exceeding service_limits.max_exclude_polygons_length.
// The hosted endpoint we use defaults to 10 km (error 167: "exceeded maximum
// circumference for exclude polygon"). Stay under that; the fallback below
// shrinks any oversized hazard footprint to a 1.5 km-radius circle
// (perimeter ≈ 9.42 km, comfortably under the 10 km cap).
const VALHALLA_AVOID_PERIMETER_LIMIT_M = 10_000;
const VALHALLA_SAFE_RADIUS_M = 1_500; // 2πr ≈ 9.42 km, under the 10 km cap

export function ringForValhallaAvoid(
  ring: Array<[number, number]>,
): Array<[number, number]> {
  if (ring.length < 3) return [];
  if (ringPerimeterMeters(ring) <= VALHALLA_AVOID_PERIMETER_LIMIT_M * 0.95) {
    return ring;
  }
  // Centroid of the input ring (simple average — fine for routing avoidance).
  let sumLat = 0;
  let sumLng = 0;
  for (const [lng, lat] of ring) {
    sumLat += lat;
    sumLng += lng;
  }
  const centre: LatLng = { lat: sumLat / ring.length, lng: sumLng / ring.length };
  // Bounding radius — farthest vertex from centroid. Capped by the safe limit.
  let boundingM = 0;
  for (const [lng, lat] of ring) {
    const d = haversineMeters(centre, { lat, lng });
    if (d > boundingM) boundingM = d;
  }
  const radius = Math.min(boundingM, VALHALLA_SAFE_RADIUS_M);
  return circleRing(centre, radius);
}

// Approximate centroid of a GeoJSON geometry (Polygon | Point).
export function geometryCentroid(geometry: any): LatLng | null {
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    return { lat, lng };
  }
  if (geometry.type === 'Polygon') {
    const ring: Array<[number, number]> = geometry.coordinates[0] ?? [];
    if (ring.length === 0) return null;
    let sumLat = 0;
    let sumLng = 0;
    for (const [lng, lat] of ring) {
      sumLat += lat;
      sumLng += lng;
    }
    return { lat: sumLat / ring.length, lng: sumLng / ring.length };
  }
  return null;
}
