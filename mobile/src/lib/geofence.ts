// Mobile alert subscriber.
//
// This module used to contain client-side decision logic — hardcoded role
// rules (radius / severity / disaster type whitelists) and a geofence loop
// that polled /api/disasters and decided "am I in danger?" locally. That
// belonged on the AI agent, not on the phone. It has been replaced with a
// thin subscriber to /api/me/notifications, which the backend scopes per
// user (geometry intersection + explicit target_user_ids set by the AI).
//
// Responsibilities now:
//   1. Poll /api/me/notifications every POLL_INTERVAL_MS.
//   2. For each *new* notification (id we haven't seen in this session),
//      surface an in-app toast AND fire an OS notification (citizens only).
//   3. Persist seen ids per (user + role) so toasts don't replay on relaunch.
//
// No proximity math. No role rules. No disaster polling. The AI decides.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import type { Session } from './auth';

const POLL_INTERVAL_MS = 5000;

function sessionScope(session: Session): string {
  const r = session.role === 'worker' ? (session.sub_role ?? 'worker') : session.role;
  return `${session.userId}:${r}`;
}

const SEEN_ALERTS_KEY = (session: Session) =>
  `sentinel.seen-alerts.v3:${sessionScope(session)}`;

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
  kind: 'alert';
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

export function useGeofenceWatcher(session: Session | null) {
  const [toasts, setToasts] = useState<GeofenceToast[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const permissionGrantedRef = useRef<boolean>(false);
  const enabled = !!session;
  const userId = session?.userId;
  const role = session?.role;
  const subRole = session?.sub_role;

  useEffect(() => {
    if (!enabled || !session || !userId) {
      seenRef.current = new Set();
      setToasts([]);
      return;
    }

    let cancelled = false;

    (async () => {
      const seen = await loadSet(SEEN_ALERTS_KEY(session));
      if (!cancelled) seenRef.current = seen;
    })();

    // OS notification permission for citizens only.
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

    const tick = async () => {
      if (cancelled) return;
      try {
        const alerts = await api.getMyNotifications(userId);
        const newEntries: GeofenceToast[] = [];
        const liveIds = new Set<string>();
        for (const a of alerts) {
          liveIds.add(a.id);
          if (seenRef.current.has(a.id)) continue;
          seenRef.current.add(a.id);
          newEntries.push({
            id: `a-${a.id}-${Date.now()}`,
            title: '🚨 Sentinel alert',
            body: a.reason || 'You are in an active alert area.',
            kind: 'alert',
          });
        }
        // Forget ids that are no longer active so they re-toast if re-issued
        // (e.g. operator drew & cleared during testing).
        let changed = newEntries.length > 0;
        for (const id of [...seenRef.current]) {
          if (!liveIds.has(id)) {
            seenRef.current.delete(id);
            changed = true;
          }
        }
        if (changed) saveSet(SEEN_ALERTS_KEY(session), seenRef.current);

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
                /* best-effort */
              }
            }
          }
        }
      } catch {
        /* network blip; skip frame */
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
