// Thin client over the Sentinel-City FastAPI backend.
//
// Base URL resolution order:
//   1. EXPO_PUBLIC_BACKEND_URL env var (explicit operator override)
//   2. Metro/Expo Go LAN host on port 8000 — auto-derived so a physical
//      device can reach the dev machine without manual config
//   3. app.json `extra.backendUrl`
//   4. http://localhost:8000 (simulator / web)

import Constants from 'expo-constants';
import {
  haversineMeters,
  routeCorridorBbox,
  ringBbox,
  bboxesIntersect,
  ringCentroid,
  ringPerimeterMeters,
  circleRing,
} from '@/lib/geo';

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

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  // Pull our own `timeoutMs` out before spreading into fetch. Without a bound,
  // a slow endpoint (e.g. the ~20s Gemini /api/city-insight call) leaves the UI
  // spinning forever if the request stalls; the AbortController turns that into
  // a catchable error the caller can fall back from.
  const { timeoutMs, ...fetchInit } = init ?? {};
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...fetchInit,
      signal: controller?.signal ?? fetchInit.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (e: any) {
    if (controller?.signal.aborted) {
      throw new Error(`Request to ${path} timed out after ${timeoutMs}ms.`);
    }
    // Network-level failure (DNS, can't reach host, CORS pre-flight). Give a
    // clearer message than "Network request failed" so the user can spot
    // backend-not-running vs. wrong-IP issues quickly.
    throw new Error(
      `Cannot reach backend at ${BACKEND_URL}. Check that the FastAPI server is running and on the same network. (${e?.message ?? 'network error'})`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${path}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── In-memory GET cache + in-flight de-duplication ─────────────────────────
// The map and alert pollers hit the same list endpoints every few seconds, from
// several screens at once. This memoizes those reads for a short TTL and shares
// a single in-flight request across concurrent callers — so the heavy payloads
// (notably the ~118 KB citizen-reports feed and the slow /api/disasters and
// /api/warnings/nearby calls) aren't re-fetched and re-parsed repeatedly.
// READS ONLY: writes never go through this and invalidate the affected keys so
// a change the user just made shows immediately rather than waiting out the TTL.
type CacheEntry = { at: number; value: unknown };
const _cache = new Map<string, CacheEntry>();
const _inflight = new Map<string, Promise<unknown>>();

function cachedGet<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const existing = _inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fetcher()
    .then((value) => {
      _cache.set(key, { at: Date.now(), value });
      _inflight.delete(key);
      return value;
    })
    .catch((e) => {
      _inflight.delete(key);
      throw e;
    });
  _inflight.set(key, p);
  return p as Promise<T>;
}

// Drop cached entries whose key starts with any given prefix (after a write).
function invalidate(...prefixes: string[]) {
  for (const key of [..._cache.keys()]) {
    if (prefixes.some((pfx) => key.startsWith(pfx))) _cache.delete(key);
  }
}

// TTLs (ms). Live data refreshes within a poll cycle; static infrastructure
// (stations) barely changes, so it's cached much longer.
const TTL_LIVE = 3000;
const TTL_WARNINGS = 4000;
const TTL_ADMIN = 4000;
const TTL_STATIONS = 60000;
// The AI insight is an expensive Gemini call whose inputs barely change. Cache
// it for several minutes so re-opening the tab is instant, matched by the
// backend's own stats-hash cache. A poll/tick won't refetch within this window.
const TTL_INSIGHT = 300000;

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
  // Concise AI-operator dispatch brief for responders (the headline). Present
  // when the call was placed via the live operator; the full caller↔operator
  // exchange is in `transcript`. null for a plain category-tap call.
  summary?: string | null;
  requested_services: EmergencyService[];
  // Top-level lifecycle summary (derived). For per-responder UI use service_status.
  status: 'new' | 'acknowledged' | 'closed';
  // Per-service lifecycle — each requested service accepts/resolves on its own
  // lane, independently of the others. A worker should read/act on their own
  // service's lane, not the summary `status`.
  service_status?: Partial<Record<EmergencyService, 'new' | 'acknowledged' | 'closed'>>;
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
  // The caller's saved profile (vitals/medical/contact), attached at call time so
  // the operator + responders can identify and brief without it being spoken in
  // the transcript. Loose record (mirrors lib/profile's CivilianProfile shape).
  caller_profile?: CallerProfile | null;
};

// Structural shape of the attached caller profile (kept loose here to avoid an
// api ↔ profile ↔ auth import cycle; lib/profile.CivilianProfile is the source).
export type CallerProfile = Record<string, string | boolean | null | undefined>;

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

// ── AI 911 operator — live conversational dispatch ──────────────────────────
// The citizen talks (voice → transcribed, or typed) back-and-forth with a
// guardrailed LLM operator that decides which responders to send. The exchange
// is persisted server-side for audit; on hang-up a concise summary is dispatched.
export type OperatorRole = 'caller' | 'operator';

export type OperatorStartResponse = { session_id: string; greeting: string };

export type OperatorMessageResponse = {
  // The caller's words (echoed back — already transcribed if they spoke).
  user_text: string;
  // What the operator says next.
  reply: string;
  // The operator's running dispatch plan (refined every turn).
  services: EmergencyService[];
  severity: number;
  category: string;
  // True once the operator believes it has enough to send the right help.
  ready_to_dispatch: boolean;
  // True when the caller's last message was off-topic (guardrail signal).
  off_topic: boolean;
  // True when a spoken clip couldn't be transcribed (caller should type/retry).
  transcription_failed: boolean;
};

export type OperatorEndResponse = {
  call: EmergencyCall;
  summary: string | null;
  key_facts: string[];
};

// Human-readable label for a 911 service identifier.
export const serviceLabel = (s: EmergencyService): string =>
  s === 'ambulance' ? 'Ambulance' : s === 'police' ? 'Police' : 'Firefighter';

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

// ── City Resilience Heatmap (admin only) ──────────────────────────────
// A weighted point for the Leaflet heat layer: [lat, lng, weight].
export type HeatPoint = [number, number, number];

export type HeatLayer = {
  points: HeatPoint[];
  // Largest raw weight in this layer — the screen normalises against it so a
  // lone point is never invisible.
  max_weight: number;
  count: number;
};

export type CityHeatmap = {
  // Casualties: responder casualty reports (critical > fainted > injured).
  casualties: HeatLayer & { by_kind: { critical: number; fainted: number; injured: number } };
  // Damage: disasters reduced to centroids, weighted by severity + at-risk.
  damage: HeatLayer & { total_est_fatalities: number };
  generated_at: string;
};

export type CityRecommendation = {
  action: string;
  rationale: string;
  target_area: string;
  priority: 'high' | 'medium' | 'low';
};

// Live Gemini-generated resilience analysis. `status` is 'done' on success,
// 'empty' when there's no data, 'unavailable' when the AI couldn't be reached.
export type CityInsight = {
  title: string;
  summary: string;
  recommendations: CityRecommendation[];
  status?: 'done' | 'empty' | 'unavailable';
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
    cachedGet('citizens', TTL_LIVE, () => request<{ citizens: MobileCitizen[] }>('/api/citizens').then((r) => r.citizens)),
  listWorkers: () =>
    cachedGet('workers', TTL_LIVE, () => request<{ workers: MobileWorker[] }>('/api/workers').then((r) => r.workers)),
  // Point reads stay uncached so a user's own position is always fresh.
  getCitizen: (id: string) => request<MobileCitizen>(`/api/citizens/${id}`),
  getWorker: (id: string) => request<MobileWorker>(`/api/workers/${id}`),
  updateCitizen: (id: string, body: Partial<{ lat: number; lng: number; status: string }>) =>
    request<MobileCitizen>(`/api/citizens/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => {
      invalidate('citizens'); // roster changed → next list read reflects it
      return r;
    }),
  updateWorker: (id: string, body: Partial<{ lat: number; lng: number; status: string }>) =>
    request<MobileWorker>(`/api/workers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then((r) => {
      invalidate('workers');
      return r;
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
    cachedGet('notifications', TTL_LIVE, () =>
      request<{ notifications: Notification[] }>('/api/notifications?status_filter=active').then((r) => r.notifications),
    ),
  listCordons: () =>
    cachedGet('cordons', TTL_LIVE, () =>
      request<{ cordons: Cordon[] }>('/api/cordons?status_filter=active').then((r) => r.cordons),
    ),
  // lat / lng can be null to request the citywide (admin) feed — the backend
  // returns every active AI warning unfiltered when position is absent.
  listNearbyWarnings: (lat: number | null, lng: number | null, radiusM: number) => {
    const q: string[] = [`radius_m=${Math.round(radiusM)}`];
    if (lat !== null && Number.isFinite(lat)) q.push(`lat=${lat}`);
    if (lng !== null && Number.isFinite(lng)) q.push(`lng=${lng}`);
    const qs = q.join('&');
    return cachedGet(`warnings:${qs}`, TTL_WARNINGS, () =>
      request<{ warnings: NearbyWarning[] }>(`/api/warnings/nearby?${qs}`).then((r) => r.warnings),
    );
  },

  // Disasters
  listDisasters: () =>
    cachedGet('disasters', TTL_LIVE, () => request<{ disasters: Disaster[] }>('/api/disasters').then((r) => r.disasters)),
  getDisaster: (id: string) => request<Disaster>(`/api/disasters/${id}`),

  // Disasters a citizen has actually reported. A disaster surfaces on mobile —
  // on the map, in routing, and for the danger banner / 911 gate — ONLY once at
  // least one citizen report references it (report.event_id === disaster.id),
  // regardless of whether it was placed by the operator or the AI. This is the
  // single source of truth for "which disasters are live on mobile"; use it
  // everywhere instead of listDisasters() + a source filter.
  // Just the distinct event ids that have a citizen report — a tiny payload that
  // replaces pulling the full ~118 KB reports feed on every poll (see backend
  // /api/reported-event-ids).
  listReportedEventIds: () =>
    cachedGet('reported-ids', TTL_LIVE, () =>
      request<{ event_ids: string[] }>('/api/reported-event-ids').then((r) => r.event_ids),
    ),
  listReportedDisasters: async (): Promise<Disaster[]> => {
    const disasters = await api.listDisasters();
    let reported: Set<string>;
    try {
      reported = new Set(await api.listReportedEventIds());
    } catch {
      // Backend without /api/reported-event-ids yet → fall back to the (heavier)
      // reports feed so nothing breaks before the server is redeployed.
      const reports = await api.listCitizenReports(500).catch(() => []);
      reported = new Set(reports.map((r) => r.event_id).filter((id): id is string => !!id));
    }
    return disasters.filter((d) => reported.has(d.id));
  },

  // Citizen reports (admin Calls screen + the reported-disaster gate). This is
  // the heaviest payload (~118 KB at limit 500) and is pulled by several pollers
  // — caching it is the single biggest perf win.
  listCitizenReports: (limit = 100) =>
    cachedGet(`reports:${limit}`, TTL_LIVE, () =>
      request<{ reports: CitizenReport[] }>(`/api/citizen-reports?limit=${limit}`).then((r) => r.reports),
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
    // Per-attempt key so a retry (flaky network / double-tap) returns the same
    // call instead of dispatching responders twice.
    idempotency_key?: string;
    // Caller's saved profile, shown to the operator / responders as structured
    // data (not spoken in the transcript).
    caller_profile?: CallerProfile | null;
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

  // ── AI 911 operator: live conversational call ──
  // Open a call session. Returns the operator's opening line.
  operatorStart: (body: {
    citizen_id: string;
    caller_lat: number;
    caller_lng: number;
    // Reverse-geocoded place name → powers the "my location" shortcut so the
    // caller never has to read out coordinates.
    location_name?: string | null;
    category?: string | null;
    disaster_id?: string | null;
    caller_profile?: CallerProfile | null;
  }) =>
    request<OperatorStartResponse>('/api/911/operator/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Transcribe a spoken clip to text WITHOUT sending it — the caller reviews/edits
  // the words in the input box, then sends via operatorMessage.
  operatorTranscribe: (body: { audio_base64: string; mime?: string; session_id?: string }) =>
    request<{ text: string; transcription_failed: boolean }>('/api/911/operator/transcribe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // One caller turn — typed `text` OR a spoken `audio_base64` clip to transcribe.
  operatorMessage: (body: { session_id: string; text?: string; audio_base64?: string; mime?: string }) =>
    request<OperatorMessageResponse>('/api/911/operator/message', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Hang up: finalize the concise brief + dispatch the responders.
  operatorEnd: (body: { session_id: string; idempotency_key?: string; photo_data_url?: string | null }) =>
    request<OperatorEndResponse>('/api/911/operator/end', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Admin
  listAgents: () => cachedGet('agents', TTL_ADMIN, () => request<{ agents: Agent[] }>('/api/agents').then((r) => r.agents)),
  savingsSummary: () => cachedGet('savings', TTL_ADMIN, () => request<SavingsSummary>('/api/savings-summary')),
  // Insight is fetched on explicit tap (per metric) — not cached.
  savingsInsight: (metric: 'lives' | 'infrastructure' | 'money') =>
    request<SavingsInsight>(`/api/savings-summary/insight?metric=${metric}`),
  statsInjured: () =>
    cachedGet('injured', TTL_ADMIN, () =>
      request<{ injured_estimate: number; contributing_events: number }>('/api/stats/injured'),
    ),
  // City Resilience Heatmap (admin). Aggregate is cheap-ish + polled → cached.
  cityHeatmap: () => cachedGet('city-heatmap', TTL_ADMIN, () => request<CityHeatmap>('/api/city-heatmap')),
  // Live AI insight — one ~20s Gemini call. Cached (+ in-flight de-duped) so a
  // tap/prefetch reuses it instead of re-spinning, and bounded by a timeout so a
  // stalled call surfaces as an error the screen can fall back from.
  cityInsight: () =>
    cachedGet('city-insight', TTL_INSIGHT, () =>
      // Cold generation is ~25-30s (stats + Gemini); give comfortable headroom
      // over the worst case + mobile/adb network overhead so it never aborts a
      // call that would have succeeded.
      request<CityInsight>('/api/city-insight', { timeoutMs: 75000 }),
    ),

  // Dispatch — reuses the same endpoints as the web operator console so the
  // mobile map shows the exact same infrastructure (fire / hospital / police).
  // Stations barely change → cached for a minute so they stop being re-fetched
  // on every 3-second map tick.
  listFireStations: () =>
    cachedGet('fireStations', TTL_STATIONS, () => request<{ stations: FireStation[] }>('/api/fire-stations').then((r) => r.stations)),
  listHospitals: () =>
    cachedGet('hospitals', TTL_STATIONS, () => request<{ hospitals: StationPoint[] }>('/api/hospitals').then((r) => r.hospitals)),
  listPoliceStations: () =>
    cachedGet('policeStations', TTL_STATIONS, () => request<{ stations: StationPoint[] }>('/api/police-stations').then((r) => r.stations)),
};

// ─── External: Valhalla routing ──────────────────────────────────────

type ValhallaManeuver = {
  instruction?: string;
  verbal_pre_transition_instruction?: string;
  length?: number; // km (units=kilometers)
  time?: number; // seconds
  type?: number; // Valhalla maneuver type
  begin_shape_index?: number;
};
type ValhallaLeg = { shape: string; maneuvers?: ValhallaManeuver[] };
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

// One turn-by-turn step from Valhalla, used for in-app navigation.
export type RouteManeuver = {
  instruction: string; // "Turn right onto Main Street."
  verbal: string; // best phrasing for text-to-speech
  distanceKm: number; // length of this step
  type: number; // Valhalla maneuver type (direction)
  lat: number;
  lng: number; // where this step begins
  shapeIndex: number; // index into Route.coordinates where this step begins
};

export type Route = {
  coordinates: Array<{ latitude: number; longitude: number }>;
  distanceKm: number;
  durationMin: number;
  // Turn-by-turn steps. Empty if the provider returned none.
  maneuvers: RouteManeuver[];
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
  const endpointSafe = avoidPolygons.filter(
    (ring) => Array.isArray(ring) && ring.length >= 3 && !isInsideRing(start, ring) && !isInsideRing(end, ring),
  );

  // Scope avoid_polygons to the route corridor. Valhalla caps both per-polygon
  // perimeter (10 km → error 167) AND total polygon count (default 50). At
  // hundreds-of-disasters scale, dumping everything on the request trips one or
  // the other even when the route itself is short and clear. Only polygons whose
  // bbox overlaps a buffered bbox around [start,end] can possibly intersect any
  // reasonable route, so the rest are noise — drop them.
  const straightLineM = haversineMeters(start, end);
  // Buffer scales with route length so detours have room: 2 km min, ~50% of the
  // straight-line distance otherwise, capped at 20 km so a long inter-city
  // route doesn't pull in the entire map's worth of hazards.
  const corridorMarginM = Math.min(20_000, Math.max(2_000, straightLineM * 0.5));
  const corridor = routeCorridorBbox(start, end, corridorMarginM);
  let safeAvoid = endpointSafe.filter((ring) => bboxesIntersect(ringBbox(ring as Array<[number, number]>), corridor));

  // Stadia's Valhalla enforces max_exclude_polygons_length on the SUM of all
  // polygon perimeters (default 10 km). One full-size polygon (≈ 9.4 km) eats
  // the whole budget; many smaller ones still bust it. So budget the total:
  // sort polygons by proximity to the route midpoint, then greedily add until
  // the budget runs out. If the next polygon doesn't fit, replace it with a
  // small circle centred on its centroid sized to fit the remaining budget —
  // we'd rather avoid a 200 m bubble of the hazard than skip it entirely.
  const mid: { lat: number; lng: number } = { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };
  const ranked = safeAvoid
    .map((ring) => {
      const r = ring as Array<[number, number]>;
      return { ring: r, dist: haversineMeters(mid, ringCentroid(r)), perim: ringPerimeterMeters(r) };
    })
    .sort((a, b) => a.dist - b.dist);

  const TOTAL_PERIMETER_BUDGET_M = 9_500; // 500 m slack under the 10 km cap
  const MIN_FALLBACK_CIRCLE_PERIMETER_M = 1_200; // ≈ 190 m radius — small but still useful
  const MAX_AVOID = 50;
  const budgeted: number[][][] = [];
  let remaining = TOTAL_PERIMETER_BUDGET_M;
  for (const item of ranked) {
    if (budgeted.length >= MAX_AVOID) break;
    if (item.perim <= remaining) {
      budgeted.push(item.ring);
      remaining -= item.perim;
      continue;
    }
    if (remaining >= MIN_FALLBACK_CIRCLE_PERIMETER_M) {
      // Shrink to a circle whose perimeter consumes the rest of the budget.
      const radius = Math.max(100, remaining / (2 * Math.PI));
      const centre = ringCentroid(item.ring);
      const ring = circleRing(centre, radius) as unknown as number[][];
      budgeted.push(ring);
      remaining = 0;
      break;
    }
    break;
  }
  safeAvoid = budgeted;

  // Valhalla rejects any route whose path exceeds 250 km (error 154). The
  // straight-line distance is a lower bound on the road distance, so if it's
  // already over the limit we fail fast with a clear message instead of a
  // cryptic "Valhalla 400 — 154 …". (Road distance can still exceed the limit
  // when the straight line is just under it — that case is caught on the
  // response below.)
  const MAX_ROUTE_M = 250_000;
  if (straightLineM > MAX_ROUTE_M) {
    throw new Error(
      `That destination is too far to route to — about ${Math.round(straightLineM / 1000)} km away. Choose a destination within 250 km.`,
    );
  }

  const postRoute = async (exclude: number[][][]): Promise<Response> => {
    const body = {
      locations: [
        { lat: start.lat, lon: start.lng },
        { lat: end.lat, lon: end.lng },
      ],
      costing,
      units: 'kilometers',
      ...(exclude.length > 0 ? { exclude_polygons: exclude } : {}),
    };
    try {
      return await fetch(`${VALHALLA_URL}/route/v1?api_key=${STADIA_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new Error(
        `Cannot reach routing service at ${VALHALLA_URL}. Verify the Stadia API key is set and your network is reachable. (${e?.message ?? 'network error'})`,
      );
    }
  };

  let res = await postRoute(safeAvoid);

  // Last-resort fallback: if the request fails ONLY because of the avoid-polygon
  // limit (Stadia caps total exclude-polygon perimeter/area/count), retry once
  // WITHOUT the hazards. A route that ignores a danger zone beats no route. We
  // already budget polygons above, so this is rare — but it guarantees a
  // polygon-limit error never breaks navigation.
  if (!res.ok && safeAvoid.length > 0) {
    let peek = '';
    try { peek = await res.clone().text(); } catch { /* clone unsupported — skip */ }
    if (/\b167\b|exclude polygon|avoid polygon|polygon/i.test(peek)) {
      res = await postRoute([]);
    }
  }
  if (!res.ok) {
    // Surface Valhalla's actual error string (e.g. "No path could be found",
    // "costing_options invalid") — otherwise debugging is a guessing game.
    let detail = res.statusText;
    let errorCode: number | undefined;
    try {
      const errBody = await res.json();
      errorCode = errBody?.error_code;
      detail = errBody?.error_code
        ? `${errBody.error_code}: ${errBody.error ?? errBody.error_message ?? 'unknown'}`
        : errBody?.error ?? errBody?.error_message ?? detail;
    } catch {
      try { detail = (await res.text()) || detail } catch { /* ignore */ }
    }
    // 154 = "path distance exceeds the max distance limit". Give the user an
    // actionable message rather than the raw Valhalla code.
    if (errorCode === 154 || /exceeds the max distance/i.test(detail)) {
      throw new Error('That destination is too far to route to. Choose a closer destination.');
    }
    // 442 = "No path could be found" — usually unreachable / across water.
    if (errorCode === 442 || /no path could be found/i.test(detail)) {
      throw new Error('No safe route to that destination could be found. Try a nearby point.');
    }
    // 167 = "exceeded maximum circumference for exclude polygon". Should be
    // prevented by ringForValhallaAvoid's perimeter cap, but if a polygon
    // still slips through we surface a clear message instead of the raw code.
    if (errorCode === 167 || /exclude polygon/i.test(detail)) {
      throw new Error('A hazard zone is too large to route around. Try a nearby point or wait a moment.');
    }
    throw new Error(`Valhalla ${res.status} — ${detail}`);
  }
  const data = (await res.json()) as ValhallaResponse;
  const points: Array<{ latitude: number; longitude: number }> = [];
  const maneuvers: RouteManeuver[] = [];
  let offset = 0; // running index into `points` across legs
  for (const leg of data.trip.legs) {
    const legPts = decodePolyline(leg.shape);
    for (const [lat, lng] of legPts) points.push({ latitude: lat, longitude: lng });
    for (const m of leg.maneuvers ?? []) {
      const instruction = (m.instruction ?? '').trim();
      if (!instruction) continue;
      const bi = Math.max(0, Math.min(legPts.length - 1, m.begin_shape_index ?? 0));
      const pt = legPts[bi] ?? legPts[0] ?? [start.lat, start.lng];
      maneuvers.push({
        instruction,
        verbal: (m.verbal_pre_transition_instruction ?? instruction).trim(),
        distanceKm: m.length ?? 0,
        type: m.type ?? 0,
        lat: pt[0],
        lng: pt[1],
        shapeIndex: offset + bi,
      });
    }
    offset += legPts.length;
  }
  return {
    coordinates: points,
    distanceKm: data.trip.summary.length,
    durationMin: data.trip.summary.time / 60,
    maneuvers,
  };
}

// ─── External: Stadia (Pelias) geocoding ─────────────────────────────
//
// Same provider + key as routing. Reverse geocoding turns a lat/lng into a
// human area name; autocomplete powers the destination search box. Both degrade
// gracefully (return null / []) when the key is missing or the network is down,
// so callers can fall back to raw coordinates and never break a screen.

const GEOCODE_URL: string =
  (process.env.EXPO_PUBLIC_GEOCODE_URL as string | undefined) ?? VALHALLA_URL;

export type PlaceSuggestion = {
  id: string;
  label: string; // primary line, e.g. "Times Square"
  secondary?: string; // context line, e.g. "Manhattan, New York"
  lat: number;
  lng: number;
};

function peliasPrimary(props: any): string {
  return (
    props?.name ||
    [props?.housenumber, props?.street].filter(Boolean).join(' ') ||
    props?.neighbourhood ||
    props?.locality ||
    props?.label ||
    ''
  );
}

function peliasSecondary(props: any, primary: string): string {
  const parts = [props?.neighbourhood, props?.locality, props?.region].filter(
    (p: string | undefined): p is string => !!p && p !== primary,
  );
  // De-dupe while preserving order.
  return [...new Set(parts)].slice(0, 2).join(', ');
}

// Reverse-geocode a coordinate to a concise area label, or null on any failure.
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url =
    `${GEOCODE_URL}/geocoding/v1/reverse?point.lat=${lat}&point.lon=${lng}` +
    `&size=1&layers=address,venue,street,neighbourhood,locality${STADIA_API_KEY ? `&api_key=${STADIA_API_KEY}` : ''}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const f = data?.features?.[0];
    if (!f) return null;
    const primary = peliasPrimary(f.properties);
    if (!primary) return f.properties?.label ?? null;
    const secondary = peliasSecondary(f.properties, primary);
    return secondary ? `${primary}, ${secondary}` : primary;
  } catch {
    return null;
  }
}

// Autocomplete place search for the destination box. `focus` biases results
// toward the user's current area. Returns [] on any failure.
export async function autocompletePlaces(
  text: string,
  focus?: { lat: number; lng: number } | null,
): Promise<PlaceSuggestion[]> {
  const q = text.trim();
  if (q.length < 3) return [];
  let url =
    `${GEOCODE_URL}/geocoding/v1/autocomplete?text=${encodeURIComponent(q)}&size=6` +
    (STADIA_API_KEY ? `&api_key=${STADIA_API_KEY}` : '');
  if (focus && Number.isFinite(focus.lat) && Number.isFinite(focus.lng)) {
    // Bias toward the user AND constrain to a routable radius so suggestions
    // can't be thousands of km away (which would fail routing with error 154).
    url +=
      `&focus.point.lat=${focus.lat}&focus.point.lon=${focus.lng}` +
      `&boundary.circle.lat=${focus.lat}&boundary.circle.lon=${focus.lng}&boundary.circle.radius=120`;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const feats: any[] = Array.isArray(data?.features) ? data.features : [];
    return feats
      .map((f, i): PlaceSuggestion | null => {
        const coords = f?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return null;
        const primary = peliasPrimary(f.properties) || f.properties?.label || 'Unknown place';
        return {
          id: f?.properties?.gid ?? `${i}-${coords[0]},${coords[1]}`,
          label: primary,
          secondary: peliasSecondary(f.properties, primary),
          lat: coords[1],
          lng: coords[0],
        };
      })
      .filter((s): s is PlaceSuggestion => s !== null);
  } catch {
    return [];
  }
}

export const config = { BACKEND_URL, VALHALLA_URL, GEOCODE_URL };
