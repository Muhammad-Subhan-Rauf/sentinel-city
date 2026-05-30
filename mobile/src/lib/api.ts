// Thin client over the Sentinel-City FastAPI backend.
//
// Base URL resolution order:
//   1. EXPO_PUBLIC_BACKEND_URL env var (explicit operator override)
//   2. Metro/Expo Go LAN host on port 8000 — auto-derived so a physical
//      device can reach the dev machine without manual config
//   3. app.json `extra.backendUrl`
//   4. http://localhost:8000 (simulator / web)

import Constants from 'expo-constants';

// Expo exposes the dev-machine host (e.g. "192.168.1.42:8081") via a few
// different fields depending on SDK version + whether the bundle is dev or
// production. Try them all.
function resolveDevHost(): string | null {
  const candidates: Array<string | undefined> = [
    (Constants.expoConfig as any)?.hostUri,
    (Constants as any).expoGoConfig?.debuggerHost,
    (Constants as any).manifest2?.extra?.expoGo?.developer?.host,
    (Constants as any).manifest?.debuggerHost,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const host = String(c).split(':')[0];
    if (!host || host === 'localhost' || host === '127.0.0.1') continue;
    return host;
  }
  return null;
}

const devHost = resolveDevHost();

const BACKEND_URL: string =
  (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ??
  (devHost ? `http://${devHost}:8000` : undefined) ??
  (Constants.expoConfig?.extra as any)?.backendUrl ??
  'http://localhost:8000';

const VALHALLA_URL: string =
  (process.env.EXPO_PUBLIC_VALHALLA_URL as string | undefined) ??
  (Constants.expoConfig?.extra as any)?.valhallaUrl ??
  'https://api.stadiamaps.com';

// Stadia API key — appended as a query param on the route call. Public
// (will end up in the APK bundle). Stadia's security model is rate-limits
// + optional origin allow-list, not key secrecy.
const STADIA_API_KEY: string =
  (process.env.EXPO_PUBLIC_STADIA_API_KEY as string | undefined) ??
  (Constants.expoConfig?.extra as any)?.stadiaApiKey ??
  '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (e: any) {
    // Network-level failure (DNS, can't reach host, CORS pre-flight). Give a
    // clearer message than "Network request failed" so the user can spot
    // backend-not-running vs. wrong-IP issues quickly.
    throw new Error(
      `Cannot reach backend at ${BACKEND_URL}. Check that the FastAPI server is running and on the same network. (${e?.message ?? 'network error'})`,
    );
  }
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

export type WorkerSubRole = 'firefighter' | 'paramedic' | 'police';

export type MobileWorker = {
  id: string;
  name: string;
  role: WorkerSubRole;
  sub_role?: WorkerSubRole;
  lat: number;
  lng: number;
  status: 'available' | 'dispatched' | 'on_scene' | 'off_duty';
  last_seen: string;
};

export type Disaster = {
  id: string;
  disaster_type: string;
  severity: number;
  area_geometry: any;
  geometry_kind: 'point' | 'area' | 'city' | null;
  notes: string | null;
  status: 'draft' | 'active' | 'cleared';
  cause: 'weather' | 'infrastructure' | null;
  spread_speed: number | null;
  people_inside: number | null;
  safe_exit_pct: number | null;
  created_at: string;
  // 'ai' | 'operator'. Mobile-side map/routing code filters to 'ai' so the
  // citizen path-planner only avoids hazards the orchestrator declared.
  source?: 'ai' | 'operator';
};

export type Notification = {
  id: string;
  geometry: any;
  reason: string;
  status: 'active' | 'cleared';
  created_at: string;
  event_id: string | null;
  // 'ai' | 'operator' — written server-side. Mobile UI only renders
  // source='ai' entries; see /api/warnings/nearby.
  source?: 'ai' | 'operator';
};

// Unified shape returned by /api/warnings/nearby. The five kinds reflect the
// five upstream sources the backend aggregates and proximity-filters.
export type NearbyWarning = {
  id: string;
  kind: 'alert' | 'cordon' | 'disaster' | 'dispatch' | 'weather';
  severity: number;
  title: string;
  message: string;
  geometry: any | null;
  distance_m: number;
  bearing: string;
  event_id: string | null;
  source: 'ai';
  created_at: string;
};

// Emergency service types a citizen can request when placing a 911 call.
export type EmergencyService = 'ambulance' | 'police' | 'firefighter';

// 911 emergency call placed by a citizen while inside an active disaster.
// Each call carries `requested_services`: workers see only calls whose
// requested set includes their own service.
export type EmergencyCall = {
  id: string;
  created_at: string;
  citizen_id: string;
  citizen_name: string;
  caller_lat: number;
  caller_lng: number;
  // null for a direct SOS not tied to any declared disaster.
  disaster_id: string | null;
  // For a disaster-linked call this is the disaster type; for a direct SOS it is
  // the chosen emergency category (e.g. "Medical", "Fire").
  disaster_type: string;
  severity: number;
  cause: 'weather' | 'infrastructure' | null;
  // True when placed via the standalone "call for help" SOS flow.
  is_direct?: boolean;
  // The emergency category chosen for a direct SOS, if any.
  category?: string | null;
  disaster_lat: number | null;
  disaster_lng: number | null;
  transcript: string;
  requested_services: EmergencyService[];
  status: 'new' | 'acknowledged' | 'closed';
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  closed_at: string | null;
  responders: Array<{
    worker_id: string;
    sub_role: 'paramedic' | 'police' | 'firefighter';
    acknowledged_at: string;
  }>;
  // Whether the caller attached a proof photo. The image itself is fetched on
  // demand via api.getCallPhoto(id) so the polled call feed stays lightweight.
  has_photo?: boolean;
  // AI authenticity verdict (see AiAssessment). Starts as { status: 'analyzing' }.
  ai_assessment?: AiAssessment;
};

// AI authenticity verdict for a 911 call. Filled in by the backend's vision
// model (pipeline.prank_check) a moment after the call is placed: it weighs the
// transcript + disaster context + the attached proof photo to estimate whether
// the call is genuine. Advisory only — responders always still see the call.
export type AiAssessment =
  | { status: 'analyzing' }
  | {
      status: 'done' | 'unavailable';
      verdict: 'genuine' | 'uncertain' | 'likely_prank';
      confidence: number; // 0..1
      photo_supports_call?: boolean | null;
      observed?: string;
      reasoning: string;
      had_photo?: boolean;
      model?: string;
    };

// Maps a worker's sub_role to the matching 911 service identifier.
export const SUBROLE_TO_SERVICE: Record<'paramedic' | 'police' | 'firefighter', EmergencyService> = {
  paramedic: 'ambulance',
  police: 'police',
  firefighter: 'firefighter',
};

export type Cordon = Notification;

export type CitizenReport = {
  id: string;
  event_id: string | null;
  citizen_idx: number;
  reported_at: string;
  report_kind: 'observation' | 'affected';
  location: { lat: number; lng: number };
  transcript: string;
  perceived_severity: number | null;
};

export type FireStation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  created_at: string;
  truck_count: number;
  trucks_dispatched: number;
};

// Minimal shape shared by hospitals + police stations (and a superset-compatible
// view of fire stations) — just what the map needs to drop a marker.
export type StationPoint = { id: string; name?: string | null; lat: number; lng: number };

export type LoginResponse = {
  user_id: string;
  role: Role;
  sub_role?: WorkerSubRole;
  name: string;
};

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
  // Auth
  login: (deviceId: string, pin: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, pin }),
    }),

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
  //
  // listNotifications / listCordons return the raw operator+AI rows. They are
  // kept for admin tooling (e.g. AdminCallsScreen) that may still need to see
  // every warning the system has issued. Every user-facing warning surface
  // (citizen + worker maps, the alerts list, geofence banners) now consumes
  // listNearbyWarnings instead, which is server-filtered to source='ai' and
  // proximity-trimmed.
  listNotifications: () =>
    request<{ notifications: Notification[] }>('/api/notifications?status_filter=active').then(
      (r) => r.notifications
    ),
  listCordons: () =>
    request<{ cordons: Cordon[] }>('/api/cordons?status_filter=active').then((r) => r.cordons),
  // lat / lng can be null to request the citywide (admin) feed — the backend
  // returns every active AI warning unfiltered when position is absent.
  listNearbyWarnings: (lat: number | null, lng: number | null, radiusM: number) => {
    const q: string[] = [`radius_m=${Math.round(radiusM)}`];
    if (lat !== null && Number.isFinite(lat)) q.push(`lat=${lat}`);
    if (lng !== null && Number.isFinite(lng)) q.push(`lng=${lng}`);
    return request<{ warnings: NearbyWarning[] }>(`/api/warnings/nearby?${q.join('&')}`).then(
      (r) => r.warnings,
    );
  },

  // Disasters
  listDisasters: () =>
    request<{ disasters: Disaster[] }>('/api/disasters').then((r) => r.disasters),
  getDisaster: (id: string) => request<Disaster>(`/api/disasters/${id}`),

  // Disasters a citizen has actually reported. A disaster surfaces on mobile —
  // on the map, in routing, and for the danger banner / 911 gate — ONLY once at
  // least one citizen report references it (report.event_id === disaster.id),
  // regardless of whether it was placed by the operator or the AI. This is the
  // single source of truth for "which disasters are live on mobile"; use it
  // everywhere instead of listDisasters() + a source filter.
  listReportedDisasters: async (): Promise<Disaster[]> => {
    const [disasters, reports] = await Promise.all([
      api.listDisasters(),
      api.listCitizenReports(500),
    ]);
    const reported = new Set(reports.map((r) => r.event_id).filter((id): id is string => !!id));
    return disasters.filter((d) => reported.has(d.id));
  },

  // Citizen reports (admin Calls screen)
  listCitizenReports: (limit = 100) =>
    request<{ reports: CitizenReport[] }>(`/api/citizen-reports?limit=${limit}`).then(
      (r) => r.reports
    ),

  // 911 calls (citizen creates, workers consume — filtered by their service)
  placeEmergencyCall: (body: {
    citizen_id: string;
    // Omit / null for a direct SOS that isn't tied to a declared disaster.
    disaster_id?: string | null;
    // Emergency category for a direct SOS (e.g. "Medical", "Fire", "Crime").
    category?: string | null;
    caller_lat: number;
    caller_lng: number;
    transcript: string;
    requested_services: EmergencyService[];
    // Optional base64 data URL ("data:image/jpeg;base64,…") of a proof photo the
    // caller captured. The backend runs an AI authenticity check against it.
    photo_data_url?: string | null;
  }) =>
    request<EmergencyCall>('/api/911/call', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Fetch the proof photo for a call on demand (kept out of the list feed).
  getCallPhoto: (id: string) =>
    request<{ id: string; photo_data_url: string }>(`/api/911/calls/${id}/photo`).then(
      (r) => r.photo_data_url,
    ),
  listEmergencyCalls: (params?: {
    statusFilter?: 'new' | 'acknowledged' | 'closed' | 'all';
    service?: EmergencyService;
  }) => {
    const q: string[] = [];
    if (params?.statusFilter) q.push(`status_filter=${params.statusFilter}`);
    if (params?.service) q.push(`service=${params.service}`);
    const suffix = q.length ? `?${q.join('&')}` : '';
    return request<{ calls: EmergencyCall[] }>(`/api/911/calls${suffix}`).then((r) => r.calls);
  },
  updateEmergencyCall: (
    id: string,
    patch: {
      status?: 'new' | 'acknowledged' | 'closed';
      worker_id?: string;
      sub_role?: 'paramedic' | 'police' | 'firefighter';
    },
  ) =>
    request<EmergencyCall>(`/api/911/calls/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // Admin
  listAgents: () => request<{ agents: Agent[] }>('/api/agents').then((r) => r.agents),
  savingsSummary: () => request<SavingsSummary>('/api/savings-summary'),
  savingsInsight: (metric: 'lives' | 'infrastructure' | 'money') =>
    request<SavingsInsight>(`/api/savings-summary/insight?metric=${metric}`),
  statsInjured: () =>
    request<{ injured_estimate: number; contributing_events: number }>('/api/stats/injured'),

  // Dispatch — reuses the same endpoints as the web operator console so the
  // mobile map shows the exact same infrastructure (fire / hospital / police).
  listFireStations: () =>
    request<{ stations: FireStation[] }>('/api/fire-stations').then((r) => r.stations),
  listHospitals: () =>
    request<{ hospitals: StationPoint[] }>('/api/hospitals').then((r) => r.hospitals),
  listPoliceStations: () =>
    request<{ stations: StationPoint[] }>('/api/police-stations').then((r) => r.stations),
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

// Ray-cast point-in-polygon on a [lng,lat] closed ring. Duplicated here to
// keep the api module free of cross-imports.
function isInsideRing(pt: { lng: number; lat: number }, ring: number[][]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  const x = pt.lng;
  const y = pt.lat;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export async function fetchRoute(
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
  avoidPolygons: number[][][] = [],
  // 'pedestrian' = walking (shortest path, uses sidewalks/footpaths);
  // 'auto' = driving (time-optimized over a road network);
  // 'bicycle' = cycling. Default to pedestrian for citizen escape routes.
  costing: 'auto' | 'pedestrian' | 'bicycle' = 'pedestrian',
): Promise<Route> {
  // Strip any avoid polygon that contains the start OR end point. Valhalla
  // returns 400 ("No path could be found") when the routing endpoints sit
  // inside a forbidden zone — which is exactly what happens to a citizen
  // already inside a danger zone. Excluding those polygons means the route
  // will start by leaving the zone, which is the desired behavior anyway.
  const safeAvoid = avoidPolygons.filter(
    (ring) => !isInsideRing(start, ring) && !isInsideRing(end, ring),
  );

  const body = {
    locations: [
      { lat: start.lat, lon: start.lng },
      { lat: end.lat, lon: end.lng },
    ],
    costing,
    units: 'kilometers',
    ...(safeAvoid.length > 0 ? { exclude_polygons: safeAvoid } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${VALHALLA_URL}/route/v1?api_key=${STADIA_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new Error(
      `Cannot reach routing service at ${VALHALLA_URL}. Verify EXPO_PUBLIC_STADIA_API_KEY is set and your network is reachable. (${e?.message ?? 'network error'})`,
    );
  }
  if (!res.ok) {
    // Surface Valhalla's actual error string (e.g. "No path could be found",
    // "costing_options invalid") — otherwise debugging is a guessing game.
    let detail = res.statusText;
    try {
      const errBody = await res.json();
      detail = errBody?.error_code
        ? `${errBody.error_code}: ${errBody.error ?? errBody.error_message ?? 'unknown'}`
        : errBody?.error ?? errBody?.error_message ?? detail;
    } catch {
      try { detail = (await res.text()) || detail } catch { /* ignore */ }
    }
    throw new Error(`Valhalla ${res.status} — ${detail}`);
  }
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
