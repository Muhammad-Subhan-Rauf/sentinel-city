// Persistent notification feed. Renders /api/me/notifications verbatim — the
// backend already scoped the list to this user (geometry intersection or
// explicit target list set by the AI). This screen is a thin renderer: no
// proximity math, no role-based filtering. If you find yourself adding "is
// this for me?" logic here, that decision belongs on the AI side instead.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View, Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import { api, Notification } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';

const DISMISSED_KEY_PREFIX = 'sentinel.alerts.dismissed.v3:';

export default function NotificationsScreen() {
  const { session } = useAuth();
  const [alerts, setAlerts] = useState<Notification[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const swipeRefs = useRef<Map<string, Swipeable>>(new Map());
  const openSwipeRef = useRef<Swipeable | null>(null);

  // Per-(device+role) storage key so two accounts on the same phone don't
  // share dismissed state.
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
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      swipeRefs.current.delete(id);
    },
    [persistDismissed],
  );

  const restoreAll = useCallback(() => {
    setDismissed(new Set());
    if (storageKey) AsyncStorage.removeItem(storageKey).catch(() => {});
  }, [storageKey]);

  const load = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const next = await api.getMyNotifications(session.userId);
      setAlerts(next.filter((a) => !dismissed.has(a.id)));
    } catch {
      /* network blip; keep last */
    } finally {
      setRefreshing(false);
    }
  }, [session, dismissed]);

  useEffect(() => {
    load();
    const handle = setInterval(load, 5000);
    return () => clearInterval(handle);
  }, [load]);

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
  ) => {
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
      <Text style={styles.subtitle}>
        Alerts issued by Sentinel for your current location.
      </Text>
      <FlatList
        style={{ flex: 1 }}
        data={alerts}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No alerts. You're in the clear.</Text>
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
        renderItem={({ item }) => (
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
              if (
                openSwipeRef.current &&
                openSwipeRef.current !== swipeRefs.current.get(item.id)
              ) {
                openSwipeRef.current.close();
              }
              openSwipeRef.current = swipeRefs.current.get(item.id) ?? null;
            }}
            onSwipeableOpen={() => dismissAlert(item.id)}
          >
            <View style={[styles.card, { borderLeftColor: colors.danger }]}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardKind}>🚨 Sentinel alert</Text>
                {item.route && (
                  <Text style={styles.cardDistance}>
                    {item.route.distanceKm.toFixed(1)} km route
                  </Text>
                )}
              </View>
              <Text style={styles.cardReason}>{item.reason}</Text>
              <Text style={styles.cardTime}>
                {item.created_at ? new Date(item.created_at).toLocaleTimeString() : ''}
              </Text>
            </View>
          </Swipeable>
        )}
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
  removeAction: {
    backgroundColor: colors.danger,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    marginBottom: 10,
    borderRadius: 12,
    width: 160,
  },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  restoreFooter: { paddingVertical: 14, alignItems: 'center' },
  restoreFooterText: { color: colors.info, fontSize: 13, fontWeight: '600' },
});
