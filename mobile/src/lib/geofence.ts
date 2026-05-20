// Role-aware in-app alerting. Combines two signals into the same toast queue:
//
//   1. Geofence entry — citizens crossing into a notification or cordon
//      polygon. (Original purpose of this module.)
//
//   2. Disaster proximity — every role gets toasted when an active disaster
//      relevant to *their* role pops up within their alert radius. First time
//      that disaster_id is seen by this session it fires; subsequent polls
//      stay quiet. Personalized headlines per role (citizen warned, fire/EMS/
//      police dispatched, admin notified citywide).
//
// One foreground poller, one queue, surfaced via InAppBanner at the root
// navigator. Local OS notifications fire alongside the in-app banner if
// permission was granted (citizens only — workers/admin don't need lock-
// screen pings while they're in-app).

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, type Disaster } from './api';
import { geometryCentroid, haversineMeters, pointInPolygon } from './geo';
import type { Session } from './auth';

const POLL_INTERVAL_MS = 5000;

// Persisted "already alerted" state, keyed per user so two accounts on the
// same device don't shadow each other. Without persistence, every app launch
// would re-fire every active disaster + every polygon the citizen is still
// standing inside, since the in-memory Sets reset on cold start.
// Each persisted set is keyed by (device_id + role + sub_role). The device_id
// alone isn't enough — the same phone signed in as citizen vs firefighter is
// two distinct "users" from the alert-state perspective, and they must not
// share dismissed/seen state. Bumping to v2 invalidates any v1 entries left
// over from the device-id-only era.
function sessionScope(session: Session): string {
  const r = session.role === 'worker' ? (session.sub_role ?? 'worker') : session.role;
  return `${session.userId}:${r}`;
}
const SEEN_DISASTERS_KEY = (session: Session) => `sentinel.seen-disasters.v2:${sessionScope(session)}`;
const INSIDE_POLYGONS_KEY = (session: Session) => `sentinel.inside-polygons.v2:${sessionScope(session)}`;

async function loadSet(key: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>): void {
  // Fire-and-forget. A failed write just means the next launch will re-toast
  // — annoying but not broken — so we don't want to block the poll loop on it.
  AsyncStorage.setItem(key, JSON.stringify([...set])).catch(() => {});
}

export type GeofenceToast = {
  id: string;
  title: string;
  body: string;
  kind: 'notification' | 'cordon' | 'disaster';
};

Notifications.setNotificationHandler({
  handleNotification: async () =>
    ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    } as any),
});

function outerRing(geometry: any): Array<[number, number]> | null {
  if (!geometry || geometry.type !== 'Polygon') return null;
  const ring = geometry.coordinates?.[0];
  return Array.isArray(ring) ? ring : null;
}

// ─── Role rules ──────────────────────────────────────────────
// `*` matches any disaster type. radiusKm = Infinity means "anywhere".

export type RoleRule = {
  types: string[];           // disaster_type whitelist; '*' = all
  radiusKm: number;          // proximity threshold; Infinity = citywide
  severityFloor: number;     // skip below this severity
};

export const ROLE_RULES: Record<string, RoleRule> = {
  citizen: { types: ['*'], radiusKm: 2, severityFloor: 1 },
  firefighter: {
    types: ['Wildfire', 'Building_Fire', 'Flood', 'Infrastructure_Failure'],
    radiusKm: 6,
    severityFloor: 1,
  },
  police: {
    types: ['Gang_Violence', 'Robbery', 'Accident', 'Road_Blockage'],
    radiusKm: 4,
    severityFloor: 1,
  },
  paramedic: {
    types: ['Building_Fire', 'Accident', 'Wildfire', 'Flood'],
    radiusKm: 5,
    severityFloor: 1,
  },
  // Admins are at a desk — they only want to hear about high-severity events,
  // but anywhere in the city. (Mobile admin = field commander on the move.)
  admin: { types: ['*'], radiusKm: Infinity, severityFloor: 4 },
};

export function ruleFor(session: Session | null): RoleRule | null {
  if (!session) return null;
  if (session.role === 'worker' && session.sub_role) {
    return ROLE_RULES[session.sub_role] ?? null;
  }
  return ROLE_RULES[session.role] ?? null;
}

export function prettyType(t: string): string {
  return t.replace(/_/g, ' ');
}

// Personalized headlines for any disaster, used by both the in-app toast and
// the Notifications screen card so the wording stays consistent across
// surfaces. distanceKm = 0 is fine for citywide (admin) entries.
export function describeDisasterForRole(
  d: Disaster,
  distanceKm: number,
  session: Session,
): { title: string; body: string } {
  return toastForDisaster(d, distanceKm, session);
}

function toastForDisaster(
  d: Disaster,
  distanceKm: number,
  session: Session,
): { title: string; body: string } {
  const t = prettyType(d.disaster_type);
  const sev = `sev ${d.severity}`;
  const distance =
    distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`;
  switch (session.role === 'worker' ? session.sub_role : session.role) {
    case 'firefighter':
      return {
        title: `🚒 Fire dispatch — ${t}`,
        body: `${sev} · ${distance} away. Stand by for response.`,
      };
    case 'police':
      return {
        title: `🚓 Police dispatch — ${t}`,
        body: `${sev} · ${distance} away. Move to scene.`,
      };
    case 'paramedic':
      return {
        title: `🚑 EMS dispatch — ${t}`,
        body: `${sev} · ${distance} away. Casualty response.`,
      };
    case 'admin':
      return {
        title: `📡 Citywide alert — ${t}`,
        body: `Active at severity ${d.severity}. Open operator console for actions.`,
      };
    case 'citizen':
    default:
      return {
        title: `⚠ Danger nearby — ${t}`,
        body: `${sev} · ${distance} away. Stay clear of red zones.`,
      };
  }
}

export function useGeofenceWatcher(session: Session | null) {
  const [toasts, setToasts] = useState<GeofenceToast[]>([]);
  // Polygons the user is currently *inside* (for citizen geofence semantics).
  const insideRef = useRef<Set<string>>(new Set());
  // Disasters we've already toasted this session — prevents the same one
  // from spamming on every poll. Cleared when session changes.
  const seenDisasterRef = useRef<Set<string>>(new Set());
  const permissionGrantedRef = useRef<boolean>(false);

  const enabled = !!session;
  const userId = session?.userId;
  const role = session?.role;
  const subRole = session?.sub_role;

  useEffect(() => {
    if (!enabled) {
      insideRef.current = new Set();
      seenDisasterRef.current = new Set();
      setToasts([]);
      return;
    }

    let cancelled = false;

    // Hydrate the persisted "already alerted" sets before the first poll
    // runs. The poller tolerates being one tick behind hydration — at worst
    // the very first tick re-toasts something — so we don't gate ticks on
    // load completion.
    if (userId && session) {
      (async () => {
        const [seen, inside] = await Promise.all([
          loadSet(SEEN_DISASTERS_KEY(session)),
          loadSet(INSIDE_POLYGONS_KEY(session)),
        ]);
        if (cancelled) return;
        seenDisasterRef.current = seen;
        insideRef.current = inside;
      })();
    }

    // OS notification permission for citizens only (locked-screen alerts).
    if (role === 'citizen') {
      (async () => {
        try {
          const { status: existing } = await Notifications.getPermissionsAsync();
          let granted = existing === 'granted';
          if (!granted) {
            const req = await Notifications.requestPermissionsAsync();
            granted = req.status === 'granted';
          }
          permissionGrantedRef.current = granted;
        } catch {
          permissionGrantedRef.current = false;
        }
      })();
    } else {
      permissionGrantedRef.current = false;
    }

    const rule = ruleFor(session);

    const tick = async () => {
      if (cancelled || !userId || !rule) return;
      try {
        // Fetch the right "me" depending on role. Admins don't have a position,
        // but their rule uses Infinity radius so they don't need one.
        const mePromise =
          role === 'citizen'
            ? api.getCitizen(userId).catch(() => null)
            : role === 'worker'
              ? api.getWorker(userId).catch(() => null)
              : Promise.resolve(null);
        const [me, notifs, cordons, disasters] = await Promise.all([
          mePromise,
          // Operator polygons are still only useful to citizens.
          role === 'citizen' ? api.listNotifications().catch(() => []) : Promise.resolve([]),
          role === 'citizen' ? api.listCordons().catch(() => []) : Promise.resolve([]),
          api.listDisasters().catch(() => [] as Disaster[]),
        ]);

        const newEntries: GeofenceToast[] = [];

        // ── (1) Citizen geofence — entered a notification/cordon polygon ──
        if (role === 'citizen' && me) {
          const point = { lat: me.lat, lng: me.lng };
          const stillInside = new Set<string>();
          for (const n of notifs) {
            const ring = outerRing(n.geometry);
            if (!ring) continue;
            if (pointInPolygon(point, ring)) {
              const polyId = `n-${n.id}`;
              stillInside.add(polyId);
              if (!insideRef.current.has(polyId)) {
                newEntries.push({
                  id: `${polyId}-${Date.now()}`,
                  title: 'Hazard zone entered',
                  body: n.reason || 'You are in an active alert area.',
                  kind: 'notification',
                });
              }
            }
          }
          for (const c of cordons) {
            const ring = outerRing(c.geometry);
            if (!ring) continue;
            if (pointInPolygon(point, ring)) {
              const polyId = `c-${c.id}`;
              stillInside.add(polyId);
              if (!insideRef.current.has(polyId)) {
                newEntries.push({
                  id: `${polyId}-${Date.now()}`,
                  title: 'No-entry cordon',
                  body: c.reason || 'You are inside a no-entry zone.',
                  kind: 'cordon',
                });
              }
            }
          }
          // Persist only when the inside-set actually changed (set equality
          // by size + every-element check). Avoids a write every 5 s when
          // the citizen is stationary.
          const prevInside = insideRef.current;
          const changed =
            prevInside.size !== stillInside.size ||
            [...stillInside].some((id) => !prevInside.has(id));
          insideRef.current = stillInside;
          if (changed && session) saveSet(INSIDE_POLYGONS_KEY(session), stillInside);
        }

        // ── (2) Disaster proximity — new relevant events for this role ──
        for (const d of disasters) {
          if (d.status !== 'active') continue;
          if (seenDisasterRef.current.has(d.id)) continue;
          if (d.severity < rule.severityFloor) continue;
          if (!(rule.types.includes('*') || rule.types.includes(d.disaster_type))) continue;

          let distanceKm = 0;
          if (Number.isFinite(rule.radiusKm)) {
            if (!me) continue; // Need a position to compute distance.
            const centroid = geometryCentroid(d.area_geometry);
            if (!centroid) continue;
            distanceKm = haversineMeters({ lat: me.lat, lng: me.lng }, centroid) / 1000;
            if (distanceKm > rule.radiusKm) continue;
          }

          seenDisasterRef.current.add(d.id);
          const { title, body } = toastForDisaster(d, distanceKm, session);
          newEntries.push({
            id: `d-${d.id}-${Date.now()}`,
            title,
            body,
            kind: 'disaster',
          });
        }

        // Drop disasters we've seen that are no longer active, so they can
        // re-alert if they're recreated (e.g. operator drew & cleared during
        // testing). Cheap O(n) loop on a small set.
        const liveIds = new Set(disasters.filter((d) => d.status === 'active').map((d) => d.id));
        let seenChanged = newEntries.some((e) => e.kind === 'disaster');
        for (const id of [...seenDisasterRef.current]) {
          if (!liveIds.has(id)) {
            seenDisasterRef.current.delete(id);
            seenChanged = true;
          }
        }
        // Persist only on actual change so we don't churn AsyncStorage every
        // poll. New toasts and resolution-cleanup both count as a change.
        if (seenChanged && session) saveSet(SEEN_DISASTERS_KEY(session), seenDisasterRef.current);

        if (newEntries.length > 0) {
          setToasts((prev) => [...prev, ...newEntries].slice(-4));
          if (permissionGrantedRef.current) {
            for (const t of newEntries) {
              try {
                await Notifications.scheduleNotificationAsync({
                  content: { title: t.title, body: t.body },
                  trigger: null,
                });
              } catch {
                // Best-effort; the in-app banner still shows.
              }
            }
          }
        }
      } catch {
        // Network blip; skip frame.
      }
    };

    tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // session is intentionally captured by closure so toastForDisaster can
    // personalize. Re-running the effect when role/userId/subRole change
    // is sufficient — pure session-object re-renders shouldn't restart the
    // poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, role, subRole]);

  const dismiss = useMemo(
    () => (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  return { toasts, dismiss };
}
