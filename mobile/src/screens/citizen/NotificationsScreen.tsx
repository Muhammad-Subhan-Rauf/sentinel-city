// Persistent notification feed for every role. Mirrors what the in-app
// toast queue surfaced (operator-drawn notifications/cordons for citizens,
// plus the role-appropriate disaster set for everyone) so the user has a
// scrollable history of what they've been alerted about. Refreshes every 5 s.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View, Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import {
  api,
  MobileCitizen,
  MobileWorker,
  Notification,
  Cordon,
  Disaster,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { geometryCentroid, haversineMeters, KM_20_M } from '@/lib/geo';
import { describeDisasterForRole, ruleFor } from '@/lib/geofence';

// Storage key for dismissed alert IDs. Scoped by (device_id + role + sub_role)
// — the same phone signed in as citizen vs firefighter has *different* user
// state, and they must not share dismissed entries. Bumping to v2 to
// invalidate any v1 keys left over from the device-id-only era.
const DISMISSED_KEY_PREFIX = 'sentinel.alerts.dismissed.v2:';

type AlertItem =
  | {
      id: string;
      kind: 'notification' | 'cordon';
      reason: string;
      distanceM: number;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'disaster';
      title: string;
      body: string;
      severity: number;
      distanceM: number;
      createdAt: string;
    };

async function fetchMe(
  role: 'citizen' | 'worker',
  id: string,
): Promise<MobileCitizen | MobileWorker | null> {
  try {
    return role === 'citizen' ? await api.getCitizen(id) : await api.getWorker(id);
  } catch {
    return null;
  }
}

export default function NotificationsScreen() {
  const { session } = useAuth();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tooFarCount, setTooFarCount] = useState(0);
  // Dismissed IDs survive app restarts via AsyncStorage so the same alert
  // doesn't come back on the next poll. Cleared from disk when the user taps
  // the "Show dismissed" footer button.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Open Swipeable refs — kept so we can close the previous one when a new
  // swipe starts (only one open at a time).
  const swipeRefs = useRef<Map<string, Swipeable>>(new Map());
  const openSwipeRef = useRef<Swipeable | null>(null);

  const rule = useMemo(() => ruleFor(session), [session]);
  // Per-(device+role) storage key. Sign-out → sign-in with a different PIN
  // switches role and therefore the key, so each role keeps its own list.
  const storageKey = useMemo(() => {
    if (!session) return null;
    const r = session.role === 'worker' ? session.sub_role ?? 'worker' : session.role;
    return `${DISMISSED_KEY_PREFIX}${session.userId}:${r}`;
  }, [session]);

  // Load persisted dismissals on mount / when the signed-in user changes.
  useEffect(() => {
    if (!storageKey) {
      setDismissed(new Set());
      return;
    }
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!raw) return setDismissed(new Set());
        try {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) setDismissed(new Set(ids));
        } catch {
          /* corrupt → start fresh */
        }
      })
      .catch(() => setDismissed(new Set()));
  }, [storageKey]);

  const persistDismissed = useCallback(
    (next: Set<string>) => {
      if (!storageKey) return;
      AsyncStorage.setItem(storageKey, JSON.stringify([...next])).catch(() => {});
    },
    [storageKey],
  );

  const dismissAlert = useCallback(
    (id: string) => {
      setDismissed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        persistDismissed(next);
        return next;
      });
      // Drop the row immediately so the UI doesn't have to wait for the next
      // poll to filter it out.
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      swipeRefs.current.delete(id);
    },
    [persistDismissed],
  );

  const restoreAll = useCallback(() => {
    setDismissed(new Set());
    if (storageKey) AsyncStorage.removeItem(storageKey).catch(() => {});
  }, [storageKey]);

  const load = async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      // Citizens/workers fetch their own "me" so distance can be computed.
      // Admins skip — their rule uses Infinity radius so distance is irrelevant.
      const me =
        session.role === 'citizen' || session.role === 'worker'
          ? await fetchMe(session.role, session.userId)
          : null;

      const wantsOperatorOverlays = session.role === 'citizen';
      const [notifs, cordons, disasters] = await Promise.all([
        wantsOperatorOverlays ? api.listNotifications().catch(() => [] as Notification[]) : Promise.resolve([] as Notification[]),
        wantsOperatorOverlays ? api.listCordons().catch(() => [] as Cordon[]) : Promise.resolve([] as Cordon[]),
        api.listDisasters().catch(() => [] as Disaster[]),
      ]);

      const combined: AlertItem[] = [];
      let far = 0;

      // Operator overlays (citizens only).
      if (me && wantsOperatorOverlays) {
        const consider = (
          list: Array<Notification | Cordon>,
          kind: 'notification' | 'cordon',
        ) => {
          for (const item of list) {
            const center = geometryCentroid(item.geometry);
            if (!center) continue;
            const d = haversineMeters({ lat: me.lat, lng: me.lng }, center);
            if (d <= KM_20_M) {
              combined.push({
                id: `${kind}-${item.id}`,
                kind,
                reason: item.reason ?? (kind === 'cordon' ? 'Cordoned area' : 'Alert'),
                distanceM: d,
                createdAt: item.created_at,
              });
            } else {
              far++;
            }
          }
        };
        consider(notifs, 'notification');
        consider(cordons, 'cordon');
      }

      // Disasters — filtered by the role's alert rule (same rule the toast
      // queue uses, so this screen matches what the user has been hearing).
      if (rule) {
        for (const d of disasters) {
          if (d.status !== 'active') continue;
          if (d.severity < rule.severityFloor) continue;
          if (!(rule.types.includes('*') || rule.types.includes(d.disaster_type))) continue;

          let distanceM = 0;
          if (Number.isFinite(rule.radiusKm)) {
            if (!me) continue;
            const centroid = geometryCentroid(d.area_geometry);
            if (!centroid) continue;
            distanceM = haversineMeters({ lat: me.lat, lng: me.lng }, centroid);
            if (distanceM / 1000 > rule.radiusKm) {
              far += 1;
              continue;
            }
          }

          const { title, body } = describeDisasterForRole(d, distanceM / 1000, session);
          combined.push({
            id: `disaster-${d.id}`,
            kind: 'disaster',
            title,
            body,
            severity: d.severity,
            distanceM,
            createdAt: d.created_at,
          });
        }
      }

      combined.sort((a, b) => a.distanceM - b.distanceM);
      // Hide anything the user has already swiped away. Re-pinning happens
      // when they tap "Show dismissed" in the footer.
      setAlerts(combined.filter((a) => !dismissed.has(a.id)));
      setTooFarCount(far);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const handle = setInterval(load, 5000);
    return () => clearInterval(handle);
    // `dismissed` intentionally captured by load() so a swipe immediately
    // applies on the next tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId, rule, dismissed]);

  const radiusLabel = rule
    ? Number.isFinite(rule.radiusKm)
      ? `Alerts within ${rule.radiusKm} km of your location.`
      : 'Citywide alerts at severity ' + rule.severityFloor + '+.'
    : 'Sign in to receive alerts.';

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
  ) => {
    // Slide the "Remove" pane in from the right as the row is dragged left.
    const translateX = dragX.interpolate({
      inputRange: [-160, 0],
      outputRange: [0, 80],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View style={[styles.removeAction, { transform: [{ translateX }] }]}>
        <Text style={styles.removeActionText}>Remove</Text>
      </Animated.View>
    );
  };

  return (
    <Screen title="Notifications" scroll={false}>
      <Text style={styles.subtitle}>{radiusLabel}</Text>
      <FlatList
        style={{ flex: 1 }}
        data={alerts}
        keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No alerts nearby. You're in the clear.</Text>
              {tooFarCount > 0 && (
                <Text style={styles.emptyMuted}>
                  {tooFarCount} active alert{tooFarCount === 1 ? '' : 's'} elsewhere in the city.
                </Text>
              )}
            </View>
          }
          ListFooterComponent={
            dismissed.size > 0 ? (
              <Pressable onPress={restoreAll} style={styles.restoreFooter}>
                <Text style={styles.restoreFooterText}>
                  Show {dismissed.size} dismissed alert{dismissed.size === 1 ? '' : 's'}
                </Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => {
            const accent =
              item.kind === 'disaster'
                ? colors.danger
                : item.kind === 'cordon'
                  ? colors.warning
                  : colors.danger;
            const distanceText =
              item.distanceM === 0
                ? 'citywide'
                : item.distanceM < 1000
                  ? `${Math.round(item.distanceM)} m`
                  : `${(item.distanceM / 1000).toFixed(1)} km`;
            return (
              <Swipeable
                ref={(ref) => {
                  if (ref) swipeRefs.current.set(item.id, ref);
                  else swipeRefs.current.delete(item.id);
                }}
                renderRightActions={renderRightActions}
                friction={1.5}
                rightThreshold={60}
                overshootRight={false}
                onSwipeableWillOpen={() => {
                  // Close any other open row so only one is open at a time.
                  if (openSwipeRef.current && openSwipeRef.current !== swipeRefs.current.get(item.id)) {
                    openSwipeRef.current.close();
                  }
                  openSwipeRef.current = swipeRefs.current.get(item.id) ?? null;
                }}
                onSwipeableOpen={() => dismissAlert(item.id)}
              >
                <View style={[styles.card, { borderLeftColor: accent }]}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardKind}>
                      {item.kind === 'disaster'
                        ? item.title
                        : item.kind === 'cordon'
                          ? '🚧 Cordon'
                          : '🚨 Evacuation Alert'}
                    </Text>
                    <Text style={styles.cardDistance}>{distanceText}</Text>
                  </View>
                  <Text style={styles.cardReason}>
                    {item.kind === 'disaster' ? item.body : item.reason}
                  </Text>
                  <Text style={styles.cardTime}>
                    {item.createdAt ? new Date(item.createdAt).toLocaleTimeString() : ''}
                  </Text>
                </View>
              </Swipeable>
            );
          }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardKind: { color: colors.textPrimary, fontWeight: '700', flex: 1, marginRight: 8 },
  cardDistance: { color: colors.info, fontWeight: '600' },
  cardReason: { color: colors.textPrimary, fontSize: 14, marginBottom: 6 },
  cardTime: { color: colors.textMuted, fontSize: 11 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  emptyMuted: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  removeAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    marginBottom: 10,
    borderRadius: 12,
    width: 160,
  },
  removeActionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  restoreFooter: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  restoreFooterText: {
    color: colors.info,
    fontSize: 13,
    fontWeight: '600',
  },
});
