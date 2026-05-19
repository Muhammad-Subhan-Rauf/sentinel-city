// Thin client over the Sentinel-City FastAPI backend.
//
// Base URL is read from app.json `extra.backendUrl`. Override at runtime by
// shaking the dev menu and editing it, or by setting EXPO_PUBLIC_BACKEND_URL.

import Constants from 'expo-constants';

const BACKEND_URL: string =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ??
  (Constants.expoConfig?.extra as any)?.backendUrl ??
  'http://localhost:8000';

const VALHALLA_URL: string =
  (process.env.EXPO_PUBLIC_VALHALLA_URL as string | undefined) ??
  (Constants.expoConfig?.extra as any)?.valhallaUrl ??
  'http://localhost:8002';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${path}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────────────

export type Role = 'citizen' | 'worker' | 'admin';

export type MobileCitizen = {
  id: string;
  name: string;
  role: 'citizen';
  lat: number;
  lng: number;
  status: 'safe' | 'warned' | 'evacuating' | 'affected';
  last_seen: string;
};

export type MobileWorker = {
  id: string;
  name: string;
  role: 'firefighter' | 'paramedic' | 'police';
  lat: number;
  lng: number;
  status: 'available' | 'dispatched' | 'on_scene' | 'off_duty';
  last_seen: string;
};

export type Disaster = {
  id: string;
  disaster_type: string;
  severity: number;
  geometry: any;
  geometry_kind: 'point' | 'area' | 'city' | null;
  notes: string | null;
  status: 'draft' | 'active';
  cause: 'weather' | 'infrastructure' | null;
  created_at: string;
};

export type Notification = {
  id: string;
  geometry: any;
  reason: string;
  status: 'active' | 'cleared';
  created_at: string;
};

export type Cordon = Notification;

export type Agent = {
  id: string;
  name: string;
  role: string;
  model: string;
  status: string;
  last_action: string;
  metrics: Record<string, number>;
};

export type SavingsSummary = {
  lives_saved: number;
  infrastructure_value_usd: number;
  money_saved_usd: number;
  as_of: string;
};

export type SavingsInsight = {
  title: string;
  summary: string;
  highlights: string[];
};

// ─── Endpoints ───────────────────────────────────────────────────────

export const api = {
  // Mobile users
  listCitizens: () =>
    request<{ citizens: MobileCitizen[] }>('/api/citizens').then((r) => r.citizens),
  listWorkers: () =>
    request<{ workers: MobileWorker[] }>('/api/workers').then((r) => r.workers),
  getCitizen: (id: string) => request<MobileCitizen>(`/api/citizens/${id}`),
  getWorker: (id: string) => request<MobileWorker>(`/api/workers/${id}`),
  updateCitizen: (id: string, body: Partial<{ lat: number; lng: number; status: string }>) =>
    request<MobileCitizen>(`/api/citizens/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  updateWorker: (id: string, body: Partial<{ lat: number; lng: number; status: string }>) =>
    request<MobileWorker>(`/api/workers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // Hazards & alerts
  listNotifications: () =>
    request<{ notifications: Notification[] }>('/api/notifications?status_filter=active').then(
      (r) => r.notifications
    ),
  listCordons: () =>
    request<{ cordons: Cordon[] }>('/api/cordons?status_filter=active').then((r) => r.cordons),

  // Admin
  listAgents: () => request<{ agents: Agent[] }>('/api/agents').then((r) => r.agents),
  savingsSummary: () => request<SavingsSummary>('/api/savings-summary'),
  savingsInsight: (metric: 'lives' | 'infrastructure' | 'money') =>
    request<SavingsInsight>(`/api/savings-summary/insight?metric=${metric}`),

  // Dispatch — reuses the same endpoint as the web app
  listFireStations: () =>
    request<{ stations: Array<{ id: string; name: string; lat: number; lng: number }> }>(
      '/api/fire-stations'
    ).then((r) => r.stations),
};

// ─── External: Valhalla routing ──────────────────────────────────────

type ValhallaLeg = { shape: string };
type ValhallaResponse = {
  trip: {
    summary: { length: number; time: number };
    legs: ValhallaLeg[];
  };
};

// Polyline6 decoder (Valhalla returns precision-6 polylines).
function decodePolyline(str: string, precision = 6): Array<[number, number]> {
  const factor = Math.pow(10, precision);
  const coords: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

export type Route = {
  coordinates: Array<{ latitude: number; longitude: number }>;
  distanceKm: number;
  durationMin: number;
};

export async function fetchRoute(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
  avoidPolygons: number[][][] = []
): Promise<Route> {
  const body = {
    locations: [
      { lat: start.lat, lon: start.lng },
      { lat: end.lat, lon: end.lng },
    ],
    costing: 'auto',
    units: 'kilometers',
    ...(avoidPolygons.length > 0 ? { avoid_polygons: avoidPolygons } : {}),
  };
  const res = await fetch(`${VALHALLA_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Valhalla ${res.status}`);
  const data = (await res.json()) as ValhallaResponse;
  const points: Array<{ latitude: number; longitude: number }> = [];
  for (const leg of data.trip.legs) {
    for (const [lat, lng] of decodePolyline(leg.shape)) {
      points.push({ latitude: lat, longitude: lng });
    }
  }
  return {
    coordinates: points,
    distanceKm: data.trip.summary.length,
    durationMin: data.trip.summary.time / 60,
  };
}

export const config = { BACKEND_URL, VALHALLA_URL };
