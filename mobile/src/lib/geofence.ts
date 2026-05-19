// Foreground geofence watcher for citizens. Polls the citizen's location +
// active notification/cordon polygons; when the citizen enters a polygon
// they were not inside last tick, fires a local notification + emits an
// in-app banner via the exposed toast queue.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { api } from './api';
import { pointInPolygon } from './geo';
import type { Session } from './auth';

const POLL_INTERVAL_MS = 8000;

export type GeofenceToast = {
  id: string;
  title: string;
  body: string;
  kind: 'notification' | 'cordon';
};

// Configure how foreground notifications surface in Expo Go / production.
// SDK 52 still uses shouldShowAlert; newer SDKs (53+) add shouldShowBanner/list.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
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

export function useGeofenceWatcher(session: Session | null) {
  const [toasts, setToasts] = useState<GeofenceToast[]>([]);
  const insideRef = useRef<Set<string>>(new Set());
  const permissionGrantedRef = useRef<boolean>(false);

  // Only run for citizens.
  const enabled = session?.role === 'citizen';
  const userId = session?.userId;

  useEffect(() => {
    if (!enabled) {
      insideRef.current = new Set();
      setToasts([]);
      return;
    }

    let cancelled = false;

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

    const tick = async () => {
      if (cancelled || !userId) return;
      try {
        const [me, notifs, cordons] = await Promise.all([
          api.getCitizen(userId).catch(() => null),
          api.listNotifications().catch(() => []),
          api.listCordons().catch(() => []),
        ]);
        if (!me) return;
        const point = { lat: me.lat, lng: me.lng };
        const stillInside = new Set<string>();
        const newEntries: GeofenceToast[] = [];

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

        insideRef.current = stillInside;

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
                // Best-effort; failure here doesn't block the in-app banner.
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
  }, [enabled, userId]);

  const dismiss = useMemo(
    () => (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    []
  );

  return { toasts, dismiss };
}
