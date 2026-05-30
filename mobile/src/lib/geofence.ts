// Role-aware in-app alerting fed by the AI-only /api/warnings/nearby endpoint.
//
// The server aggregates five upstream AI sources (citizen alerts, cordons,
// declared disasters, active dispatches, weather alerts), proximity-filters
// them against the user's location, and returns one unified list. This module
// polls that endpoint, dedupes against an "already toasted" set, and emits
// the new entries to the InAppBanner queue (plus a locked-screen notification
// for citizens).
//
// Operator-drawn dashboard warnings never appear here — they're filtered out
// at the source='ai' boundary in the backend.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, type NearbyWarning } from './api';
import type { Session } from './auth';

const POLL_INTERVAL_MS = 5000;

// Persisted "already alerted" state, keyed per user so two accounts on the
// same device don't shadow each other. Without persistence, every app launch
// would re-fire every active warning still in range. v3 bumps from v2 because
// the keying scheme is now per-warning-id (not per-disaster-id).
function sessionScope(session: Session): string {
  const r = session.role === 'worker' ? (session.sub_role ?? 'worker') : session.role;
  return `${session.userId}:${r}`;
}
const SEEN_WARNINGS_KEY = (session: Session) => `sentinel.seen-warnings.v3:${sessionScope(session)}`;

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
  AsyncStorage.setItem(key, JSON.stringify([...set])).catch(() => {});
}

export type GeofenceToast = {
  id: string;
  title: string;
  body: string;
  kind: NearbyWarning['kind'];
  severity: number;
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

// ─── Role rules ──────────────────────────────────────────────
// radiusKm = Infinity means "citywide" — geofence.ts asks the server for the
// unfiltered feed by omitting lat/lng (see queryFor below).

export type RoleRule = {
  radiusKm: number;          // Infinity = citywide (admin only)
  severityFloor: number;     // skip warnings below this severity
};

export const ROLE_RULES: Record<string, RoleRule> = {
  citizen: { radiusKm: 2, severityFloor: 1 },
  firefighter: { radiusKm: 6, severityFloor: 1 },
  police: { radiusKm: 4, severityFloor: 1 },
  paramedic: { radiusKm: 5, severityFloor: 1 },
  // Admins are at a desk — citywide feed, only high-severity rows.
  admin: { radiusKm: Infinity, severityFloor: 4 },
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

// Personalised wording for the in-app banner. The server's title/message is
// already user-friendly for `alert` / `cordon` / `weather` / `dispatch`. The
// only kind that benefits from role-specific phrasing is `disaster` — a
// firefighter wants "Fire dispatch", a citizen wants "Danger nearby".
function toastFor(w: NearbyWarning, session: Session): { title: string; body: string } {
  const distance =
    w.distance_m < 1000
      ? `${Math.round(w.distance_m)} m`
      : `${(w.distance_m / 1000).toFixed(1)} km`;
  const bearing = w.bearing && w.bearing !== '—' ? ` ${w.bearing}` : '';
  const audience = session.role === 'worker' ? session.sub_role : session.role;

  // Titles are emoji-free: the in-app banner / Alerts feed render a vector icon
  // keyed off `w.kind` (see warningKindIcon), so glyphs live in the UI layer.
  if (w.kind === 'disaster') {
    const t = prettyType(w.title);
    const sev = `sev ${w.severity}`;
    switch (audience) {
      case 'firefighter':
        return { title: `Fire dispatch — ${t}`, body: `${sev} · ${distance}${bearing} away.` };
      case 'police':
        return { title: `Police dispatch — ${t}`, body: `${sev} · ${distance}${bearing} away.` };
      case 'paramedic':
        return { title: `EMS dispatch — ${t}`, body: `${sev} · ${distance}${bearing} away.` };
      case 'admin':
        return { title: `Citywide alert — ${t}`, body: `Active at severity ${w.severity}.` };
      case 'citizen':
      default:
        return { title: `Danger nearby — ${t}`, body: `${sev} · ${distance}${bearing} away. Stay clear.` };
    }
  }
  if (w.kind === 'cordon') {
    return { title: w.title, body: `${w.message} (${distance}${bearing})` };
  }
  if (w.kind === 'dispatch') {
    return { title: w.title, body: w.message };
  }
  if (w.kind === 'weather') {
    return { title: w.title, body: w.message };
  }
  // alert
  return { title: w.title, body: `${w.message} (${distance}${bearing})` };
}

// Describe a single warning for the Notifications screen. Same wording rules
// as the banner so users see consistent text across surfaces.
export function describeWarningForRole(
  w: NearbyWarning,
  session: Session,
): { title: string; body: string } {
  return toastFor(w, session);
}

export function useGeofenceWatcher(session: Session | null) {
  const [toasts, setToasts] = useState<GeofenceToast[]>([]);
  // Warning ids we've already toasted this session.
  const seenRef = useRef<Set<string>>(new Set());
  const permissionGrantedRef = useRef<boolean>(false);

  const enabled = !!session;
  const userId = session?.userId;
  const role = session?.role;
  const subRole = session?.sub_role;

  useEffect(() => {
    if (!enabled) {
      seenRef.current = new Set();
      setToasts([]);
      return;
    }

    let cancelled = false;

    if (userId && session) {
      (async () => {
        const seen = await loadSet(SEEN_WARNINGS_KEY(session));
        if (cancelled) return;
        seenRef.current = seen;
      })();
    }

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
      if (cancelled || !userId || !rule || !session) return;
      try {
        // Citywide (admin) skips the position lookup and asks for the
        // unfiltered feed. Citizens + workers need their current lat/lng so
        // the server can proximity-filter.
        let warnings: NearbyWarning[] = [];
        if (!Number.isFinite(rule.radiusKm)) {
          // Admin path — pass null so api.listNearbyWarnings omits lat/lng
          // and the backend returns every active AI warning.
          warnings = await api.listNearbyWarnings(null, null, 50000).catch(() => []);
        } else {
          // Citizen / worker — need our latest position.
          const me =
            role === 'citizen'
              ? await api.getCitizen(userId).catch(() => null)
              : role === 'worker'
                ? await api.getWorker(userId).catch(() => null)
                : null;
          if (!me) return;
          warnings = await api
            .listNearbyWarnings(me.lat, me.lng, rule.radiusKm * 1000)
            .catch(() => []);
        }

        const newEntries: GeofenceToast[] = [];
        const liveIds = new Set(warnings.map((w) => w.id));

        for (const w of warnings) {
          if (w.severity < rule.severityFloor) continue;
          if (seenRef.current.has(w.id)) continue;
          const { title, body } = toastFor(w, session);
          seenRef.current.add(w.id);
          newEntries.push({
            id: `${w.id}-${Date.now()}`,
            title,
            body,
            kind: w.kind,
            severity: w.severity,
          });
        }

        // Drop seen ids that have left the live list, so a recreated warning
        // can re-toast (operator-test scenarios).
        let seenChanged = newEntries.length > 0;
        for (const id of [...seenRef.current]) {
          if (!liveIds.has(id)) {
            seenRef.current.delete(id);
            seenChanged = true;
          }
        }
        if (seenChanged && session) saveSet(SEEN_WARNINGS_KEY(session), seenRef.current);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, role, subRole]);

  const dismiss = useMemo(
    () => (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  return { toasts, dismiss };
}
