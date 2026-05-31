// Centralised tab-badge counts so a role's bottom nav shows pending work even
// when that tab isn't open. Polled here (not inside the screens) so the badge is
// live regardless of which tab is mounted/focused.
//
//   citizen → Alerts (active nearby warnings, minus dismissed) + History (open cases)
//   worker  → Alerts (active warnings in range) + Calls (new 911 calls for the service)
//   admin   → Alerts (citywide active warnings)
//
// Alert counts mirror NotificationsScreen exactly: same per-role radius
// (ruleFor) and the same persisted "dismissed" set, so the badge matches what
// the user sees on the Alerts tab.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, NearbyWarning, SUBROLE_TO_SERVICE } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { ruleFor } from '@/lib/geofence';

const POLL_MS = 6000;
const DISMISSED_KEY_PREFIX = 'sentinel.alerts.dismissed.v2:';

export type TabBadges = { alerts: number; calls: number; history: number };
const EMPTY: TabBadges = { alerts: 0, calls: 0, history: 0 };

// Lets a screen force an immediate badge re-poll (e.g. after the citizen
// dismisses or clears alerts) so the tab count updates instantly instead of
// waiting for the next poll cycle.
const refreshListeners = new Set<() => void>();
export function refreshBadges() {
  for (const fn of refreshListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function dismissedKey(session: Session): string {
  const r = session.role === 'worker' ? session.sub_role ?? 'worker' : session.role;
  return `${DISMISSED_KEY_PREFIX}${session.userId}:${r}`;
}

async function loadDismissed(session: Session): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(dismissedKey(session));
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? new Set<string>(ids) : new Set();
  } catch {
    return new Set();
  }
}

async function countAlerts(session: Session): Promise<number> {
  const rule = ruleFor(session);
  if (!rule) return 0;
  let warnings: NearbyWarning[] = [];
  if (Number.isFinite(rule.radiusKm)) {
    const me =
      session.role === 'citizen'
        ? await api.getCitizen(session.userId).catch(() => null)
        : await api.getWorker(session.userId).catch(() => null);
    if (!me) return 0;
    warnings = await api.listNearbyWarnings(me.lat, me.lng, rule.radiusKm * 1000).catch(() => []);
  } else {
    warnings = await api.listNearbyWarnings(null, null, 50000).catch(() => []);
  }
  const dismissed = await loadDismissed(session);
  return warnings.filter((w) => !dismissed.has(w.id)).length;
}

/** Live badge counts for the active role's tabs. Returns zeros when signed out. */
export function useTabBadges(session: Session | null): TabBadges {
  const [badges, setBadges] = useState<TabBadges>(EMPTY);

  useEffect(() => {
    if (!session) {
      setBadges(EMPTY);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        if (session.role === 'worker') {
          const service = session.sub_role ? SUBROLE_TO_SERVICE[session.sub_role] : undefined;
          const [alerts, calls] = await Promise.all([
            countAlerts(session),
            service
              ? api.listEmergencyCalls({ statusFilter: 'new', service }).then((c) => c.length).catch(() => 0)
              : Promise.resolve(0),
          ]);
          if (!cancelled) setBadges({ alerts, calls, history: 0 });
        } else if (session.role === 'citizen') {
          const [alerts, all] = await Promise.all([
            countAlerts(session),
            api.listEmergencyCalls({ statusFilter: 'all' }).catch(() => []),
          ]);
          if (cancelled) return;
          const history = all.filter((c) => c.citizen_id === session.userId && c.status !== 'closed').length;
          setBadges({ alerts, calls: 0, history });
        } else {
          const alerts = await countAlerts(session);
          if (!cancelled) setBadges({ alerts, calls: 0, history: 0 });
        }
      } catch {
        /* keep last good counts on a transient error */
      }
    };

    tick();
    const handle = setInterval(tick, POLL_MS);
    const onExternalRefresh = () => {
      tick();
    };
    refreshListeners.add(onExternalRefresh);
    return () => {
      cancelled = true;
      clearInterval(handle);
      refreshListeners.delete(onExternalRefresh);
    };
  }, [session?.userId, session?.role, session?.sub_role]);

  return badges;
}

/** Format a count for a tab badge: undefined when zero (hidden), capped at 99+. */
export function badgeValue(n: number): number | string | undefined {
  if (!n || n <= 0) return undefined;
  return n > 99 ? '99+' : n;
}
