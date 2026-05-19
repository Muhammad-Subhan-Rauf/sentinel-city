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
