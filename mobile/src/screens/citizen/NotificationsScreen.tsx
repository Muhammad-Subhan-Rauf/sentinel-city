// Persistent notification feed for every role. Mirrors what the in-app toast
// queue surfaced (citizen alerts, cordons, disasters, dispatches and weather
// alerts — all AI-only) so the user has a scrollable history. Refreshes every 5s.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, View, Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import { api, MobileCitizen, MobileWorker, NearbyWarning } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, IconBadge, Badge, Icon, EmptyState, SkeletonCard, warningKindIcon } from '@/components/ui';
import { describeWarningForRole, ruleFor } from '@/lib/geofence';
import { refreshBadges } from '@/lib/badges';

const DISMISSED_KEY_PREFIX = 'sentinel.alerts.dismissed.v2:';

type AlertItem = {
  id: string;
  kind: NearbyWarning['kind'];
  title: string;
  body: string;
  severity: number;
  distanceM: number;
  createdAt: string;
};

const SEVERITY_WORD = ['Minor', 'Moderate', 'Major', 'Severe', 'Critical'];
const severityWord = (s: number) => SEVERITY_WORD[Math.max(1, Math.min(5, Math.round(s))) - 1];

async function fetchMe(role: 'citizen' | 'worker', id: string): Promise<MobileCitizen | MobileWorker | null> {
  try {
    return role === 'citizen' ? await api.getCitizen(id) : await api.getWorker(id);
  } catch {
    return null;
  }
}

export default function NotificationsScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const swipeRefs = useRef<Map<string, Swipeable>>(new Map());
  const openSwipeRef = useRef<Swipeable | null>(null);

  const rule = useMemo(() => ruleFor(session), [session]);
  const storageKey = useMemo(() => {
    if (!session) return null;
    const r = session.role === 'worker' ? session.sub_role ?? 'worker' : session.role;
    return `${DISMISSED_KEY_PREFIX}${session.userId}:${r}`;
  }, [session]);

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

  // Persist the dismissed set, then refresh the tab badge so its count drops
  // instantly (rather than waiting for the badge poller's next cycle).
  const persistDismissed = useCallback(
    (next: Set<string>) => {
      if (!storageKey) return;
      AsyncStorage.setItem(storageKey, JSON.stringify([...next]))
        .catch(() => {})
        .finally(() => refreshBadges());
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
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      swipeRefs.current.delete(id);
    },
    [persistDismissed],
  );

  // Dismiss every alert currently showing. Reversible via "Show N dismissed".
  const clearAll = useCallback(() => {
    if (alerts.length === 0) return;
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const a of alerts) next.add(a.id);
      persistDismissed(next);
      return next;
    });
    setAlerts([]);
    for (const ref of swipeRefs.current.values()) {
      try {
        ref.close();
      } catch {
        /* ignore */
      }
    }
    swipeRefs.current.clear();
    openSwipeRef.current = null;
  }, [alerts, persistDismissed]);

  const restoreAll = useCallback(() => {
    setDismissed(new Set());
    if (storageKey) AsyncStorage.removeItem(storageKey).catch(() => {}).finally(() => refreshBadges());
  }, [storageKey]);

  const load = async () => {
    if (!session || !rule) return;
    setRefreshing(true);
    try {
      let warnings: NearbyWarning[] = [];
      if (Number.isFinite(rule.radiusKm)) {
        const me =
          session.role === 'citizen' || session.role === 'worker'
            ? await fetchMe(session.role, session.userId)
            : null;
        if (!me) {
          setAlerts([]);
          return;
        }
        warnings = await api.listNearbyWarnings(me.lat, me.lng, rule.radiusKm * 1000).catch(() => []);
      } else {
        warnings = await api.listNearbyWarnings(null, null, 50000).catch(() => []);
      }

      const combined: AlertItem[] = [];
      for (const w of warnings) {
        if (w.severity < rule.severityFloor) continue;
        const { title, body } = describeWarningForRole(w, session);
        combined.push({
          id: w.id,
          kind: w.kind,
          title,
          body,
          severity: w.severity,
          distanceM: w.distance_m,
          createdAt: w.created_at,
        });
      }
      combined.sort((a, b) => a.distanceM - b.distanceM);
      setAlerts(combined.filter((a) => !dismissed.has(a.id)));
    } finally {
      setRefreshing(false);
      setFirstLoad(false);
    }
  };

  useEffect(() => {
    load();
    const handle = setInterval(load, 8000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId, rule, dismissed]);

  const radiusLabel = rule
    ? Number.isFinite(rule.radiusKm)
      ? `Within ${rule.radiusKm} km of your location`
      : `Citywide · severity ${rule.severityFloor}+`
    : 'Sign in to receive alerts';

  const RemovePane = () => (
    <Animated.View style={[styles.removeAction, { backgroundColor: t.color.danger, borderRadius: t.radius.lg }]}>
      <Icon name="trash" size={24} color={t.color.onDanger} />
    </Animated.View>
  );
  // Swipe left → action pane on the right; swipe right → pane on the left.
  // Either direction removes the alert (see onSwipeableOpen).
  const renderRightActions = () => <RemovePane />;
  const renderLeftActions = () => <RemovePane />;

  return (
    <Screen
      title="Alerts"
      subtitle={radiusLabel}
      scroll={false}
      padded={false}
      right={
        alerts.length > 0 ? (
          <Pressable
            onPress={clearAll}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Clear all ${alerts.length} alerts`}
            style={styles.clearAllBtn}
          >
            <Icon name="trash" size={14} color={t.color.danger} />
            <Text variant="label" tone="danger">
              Clear all
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      {firstLoad && alerts.length === 0 ? (
        <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.sm }}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={alerts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: t.spacing.lg, paddingTop: t.spacing.sm, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.color.primary} />}
          ListEmptyComponent={
            <EmptyState
              icon="shield"
              tone={t.color.success}
              title="You're in the clear"
              body="No active alerts in your area right now. We'll notify you the moment something changes nearby."
            />
          }
          ListFooterComponent={
            dismissed.size > 0 ? (
              <Pressable onPress={restoreAll} style={styles.restoreFooter} accessibilityRole="button">
                <Icon name="refresh" size={15} color={t.color.primary} />
                <Text variant="label" tone="accent">
                  Show {dismissed.size} dismissed alert{dismissed.size === 1 ? '' : 's'}
                </Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => {
            const accent = t.severityColor(item.severity);
            const distanceText =
              item.distanceM === 0
                ? 'Citywide'
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
                renderLeftActions={renderLeftActions}
                friction={1.5}
                rightThreshold={60}
                leftThreshold={60}
                overshootRight={false}
                overshootLeft={false}
                onSwipeableWillOpen={() => {
                  if (openSwipeRef.current && openSwipeRef.current !== swipeRefs.current.get(item.id)) {
                    openSwipeRef.current.close();
                  }
                  openSwipeRef.current = swipeRefs.current.get(item.id) ?? null;
                }}
                onSwipeableOpen={() => dismissAlert(item.id)}
              >
                <Card accent={accent} style={{ marginBottom: t.spacing.md }}>
                  <View style={styles.cardTop}>
                    <IconBadge name={warningKindIcon(item.kind)} color={accent} size={40} />
                    <View style={{ flex: 1, marginLeft: t.spacing.md }}>
                      <Text variant="h3" numberOfLines={2}>
                        {item.title}
                      </Text>
                    </View>
                    <View style={styles.distancePill}>
                      <Icon name="location" size={12} color={t.color.textMuted} />
                      <Text variant="caption" tone="secondary" style={{ fontFamily: t.fonts.bold }}>
                        {distanceText}
                      </Text>
                    </View>
                  </View>
                  <Text variant="body" tone="secondary" style={{ marginTop: t.spacing.sm }}>
                    {item.body}
                  </Text>
                  <View style={styles.cardFooter}>
                    <Badge label={`Sev ${item.severity} · ${severityWord(item.severity)}`} color={accent} icon="alert" />
                    <View style={styles.timeRow}>
                      <Icon name="time" size={12} color={t.color.textMuted} />
                      <Text variant="caption" tone="muted">
                        {item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Swipeable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  distancePill: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 8 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removeAction: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12, width: 80 },
  restoreFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16 },
  clearAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
