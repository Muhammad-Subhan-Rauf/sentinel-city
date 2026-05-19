// OpenStreetMap Nominatim — used by the Mock Location screen to autocomplete
// addresses. Free, no API key, but rate-limited; keep a short debounce.

export type Suggestion = {
  display_name: string;
  lat: number;
  lng: number;
};

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Suggestion[]> {
  if (query.trim().length < 3) return [];
  const url = `${NOMINATIM}?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'sentinel-city-mobile/1.0' },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return data.map((d) => ({
    display_name: d.display_name,
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon),
  }));
}
