// Worker-side 911 call log. Each worker sub-role (police / firefighter /
// paramedic) sees only the calls whose requested_services include their service.
// "Acknowledge" PATCHes the backend AND pushes a dispatch target into the local
// pub-sub — the worker's Map tab subscribes and auto-routes to the caller.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '@/components/Screen';
import { api, EmergencyCall, EmergencyService, SUBROLE_TO_SERVICE } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Button, Badge, Icon, IconBadge, EmptyState, serviceIcon, BadgeTone } from '@/components/ui';
import { CallEvidence } from '@/components/CallEvidence';
import { PlaceLabel } from '@/lib/geocode';
import { setDispatchTarget, scopeKeyFor } from '@/lib/dispatchTarget';

const POLL_MS = 4000;

const CLEARED_CALLS_KEY = (userId: string, subRole: string) => `sentinel.cleared-calls.v1:${userId}:${subRole}`;

const STATUS_TONE: Record<EmergencyCall['status'], BadgeTone> = {
  new: 'danger',
  acknowledged: 'warning',
  closed: 'neutral',
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export default function WorkerCallLogsScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const navigation = useNavigation<any>();
  const [calls, setCalls] = useState<EmergencyCall[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const subRole = (session?.role === 'worker' ? session?.sub_role : undefined) ?? 'police';
  const service: EmergencyService = SUBROLE_TO_SERVICE[subRole as keyof typeof SUBROLE_TO_SERVICE] ?? 'police';

  const STATUS_ACCENT: Record<EmergencyCall['status'], string> = {
    new: t.color.danger,
    acknowledged: t.color.warning,
    closed: t.color.textMuted,
  };

  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const storageKey = session ? CLEARED_CALLS_KEY(session.userId, subRole) : null;
  const swipeRefs = useRef<Map<string, Swipeable>>(new Map());
  const openSwipeRef = useRef<Swipeable | null>(null);

  useEffect(() => {
    if (!storageKey) {
      setCleared(new Set());
      return;
    }
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!raw) return setCleared(new Set());
        try {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) setCleared(new Set(ids));
        } catch {
          /* corrupt → start fresh */
        }
      })
      .catch(() => setCleared(new Set()));
  }, [storageKey]);

  const persistCleared = useCallback(
    (next: Set<string>) => {
      if (!storageKey) return;
      AsyncStorage.setItem(storageKey, JSON.stringify([...next])).catch(() => {});
    },
    [storageKey],
  );

  const clearOne = useCallback(
    (id: string) => {
      setCleared((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        persistCleared(next);
        return next;
      });
      swipeRefs.current.delete(id);
    },
    [persistCleared],
  );

  const clearAllHistory = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setCleared((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        persistCleared(next);
        return next;
      });
      for (const ref of swipeRefs.current.values()) {
        try {
          ref.close();
        } catch {
          /* ignore */
        }
      }
      openSwipeRef.current = null;
    },
    [persistCleared],
  );

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await api.listEmergencyCalls({ statusFilter: 'all', service });
      setCalls(fresh);
    } catch {
      /* keep last good state on transient errors */
    } finally {
      setRefreshing(false);
      setFirstLoad(false);
    }
  }, [service]);

  useEffect(() => {
    load();
    const handle = setInterval(load, POLL_MS);
    return () => clearInterval(handle);
  }, [load]);

  const acknowledgeAndRoute = async (call: EmergencyCall) => {
    if (!session) return;
    setBusyId(call.id);
    try {
      const updated = await api.updateEmergencyCall(call.id, {
        status: 'acknowledged',
        worker_id: session.userId,
        sub_role: subRole as 'paramedic' | 'police' | 'firefighter',
      });
      setCalls((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      const scope = scopeKeyFor(session.userId, subRole);
      setDispatchTarget(scope, {
        callId: updated.id,
        lat: updated.caller_lat,
        lng: updated.caller_lng,
        label: `${updated.citizen_name} · ${updated.disaster_type.replace(/_/g, ' ')} sev ${updated.severity}`,
        caller_name: updated.citizen_name,
        disaster_type: updated.disaster_type,
        severity: updated.severity,
      });
      try {
        navigation.navigate('Map');
      } catch {
        /* not in a nav context; fine */
      }
    } catch {
      /* surface inline later */
    } finally {
      setBusyId(null);
    }
  };

  const closeCall = async (call: EmergencyCall) => {
    if (!session) return;
    setBusyId(call.id);
    try {
      const updated = await api.updateEmergencyCall(call.id, { status: 'closed' });
      setCalls((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      const scope = scopeKeyFor(session.userId, subRole);
      setDispatchTarget(scope, null);
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  const [tab, setTab] = useState<'active' | 'history'>('active');
  const { activeCalls, historyCalls, newCount, hiddenHistoryCount } = useMemo(() => {
    const active: EmergencyCall[] = [];
    const historyAll: EmergencyCall[] = [];
    for (const c of calls) {
      if (c.status === 'closed') historyAll.push(c);
      else active.push(c);
    }
    const history = historyAll.filter((c) => !cleared.has(c.id));
    return {
      activeCalls: active,
      historyCalls: history,
      newCount: active.filter((c) => c.status === 'new').length,
      hiddenHistoryCount: historyAll.length - history.length,
    };
  }, [calls, cleared]);

  const visibleCalls = tab === 'active' ? activeCalls : historyCalls;

  const confirmClearAll = () => {
    if (historyCalls.length === 0) return;
    Alert.alert(
      'Clear all history?',
      `This hides ${historyCalls.length} resolved call${historyCalls.length === 1 ? '' : 's'} from your view. They stay on the server for audit.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => clearAllHistory(historyCalls.map((c) => c.id)) },
      ],
    );
  };

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
  ) => {
    const translateX = dragX.interpolate({ inputRange: [-160, 0], outputRange: [0, 80], extrapolate: 'clamp' });
    return (
      <Animated.View style={[styles.removeAction, { backgroundColor: t.color.danger, borderRadius: t.radius.lg, transform: [{ translateX }] }]}>
        <Icon name="trash" size={20} color={t.color.onDanger} />
        <Text variant="label" color={t.color.onDanger} style={{ marginTop: 2 }}>
          Clear
        </Text>
      </Animated.View>
    );
  };

  const Segment = ({ id, label, icon, count, tone }: { id: 'active' | 'history'; label: string; icon: 'alert' | 'time'; count: number; tone: string }) => {
    const on = tab === id;
    return (
      <Pressable
        onPress={() => setTab(id)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        style={({ pressed }) => [
          styles.segment,
          {
            borderRadius: t.radius.md,
            borderColor: on ? tone : t.color.border,
            backgroundColor: on ? t.color.surfaceHover : t.color.surface,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Icon name={icon} size={16} color={on ? tone : t.color.textMuted} />
        <Text variant="label" color={on ? t.color.textPrimary : t.color.textMuted} style={{ flex: 1 }}>
          {label}
        </Text>
        <Badge label={String(count)} solid={on} tone={id === 'active' ? 'danger' : 'accent'} color={on ? tone : undefined} />
      </Pressable>
    );
  };

  return (
    <Screen
      title="911 Call Log"
      subtitle={`${service} calls · ${newCount > 0 ? `${newCount} awaiting response` : 'no new calls'}`}
      scroll={false}
      padded={false}
    >
      <GestureHandlerRootView style={{ flex: 1, paddingHorizontal: t.spacing.lg }}>
        <View style={styles.tabRow}>
          <Segment id="active" label="Active" icon="alert" count={activeCalls.length} tone={t.color.danger} />
          <Segment id="history" label="History" icon="time" count={historyCalls.length} tone={t.color.primary} />
        </View>

        {firstLoad ? (
          <ActivityIndicator color={t.color.primary} style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            style={{ flex: 1 }}
            data={visibleCalls}
            keyExtractor={(c) => c.id}
            contentContainerStyle={{ paddingBottom: t.spacing.xxxl, flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.color.primary} />}
            ListEmptyComponent={
              tab === 'active' ? (
                <EmptyState
                  icon="calls"
                  tone={t.color.primary}
                  title={`No active ${service} calls`}
                  body={`Citizens inside an active disaster zone can request ${service} from their 911 dialog. Their call appears here in real time.`}
                />
              ) : (
                <EmptyState icon="time" tone={t.color.textMuted} title="No resolved calls yet" body="Closed calls land here for the rest of the shift so you can look back at recent dispatches." />
              )
            }
            ListFooterComponent={
              tab === 'history' && historyCalls.length > 0 ? (
                <Button label={`Clear all ${historyCalls.length} resolved`} variant="ghost" icon="trash" onPress={confirmClearAll} style={{ marginTop: 8 }} />
              ) : tab === 'history' && hiddenHistoryCount > 0 ? (
                <Text variant="caption" tone="muted" center style={{ paddingVertical: 10 }}>
                  {hiddenHistoryCount} hidden call{hiddenHistoryCount === 1 ? '' : 's'} — cleared from this device.
                </Text>
              ) : null
            }
            renderItem={({ item }) => {
              const accent = STATUS_ACCENT[item.status];
              const busy = busyId === item.id;
              const meAcknowledged = item.responders?.some((r) => r.worker_id === session?.userId);

              const cardBody = (
                <Card accent={accent} style={{ marginBottom: t.spacing.md }}>
                  <View style={styles.cardHeader}>
                    <IconBadge name="disaster" color={t.severityColor(item.severity)} size={40} />
                    <View style={{ flex: 1, marginHorizontal: t.spacing.md }}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {item.disaster_type.replace(/_/g, ' ')}
                      </Text>
                      <Text variant="caption" tone="secondary">
                        Caller: {item.citizen_name} · sev {item.severity}
                      </Text>
                    </View>
                    <Badge label={item.status} tone={STATUS_TONE[item.status]} />
                  </View>

                  <View style={styles.tagRow}>
                    {item.is_direct && <Badge label="Direct SOS" icon="alert" tone="warning" />}
                    {item.requested_services.map((s) => (
                      <Badge key={s} label={s} icon={serviceIcon(s)} tone={s === service ? 'accent' : 'neutral'} />
                    ))}
                  </View>

                  <View style={[styles.transcript, { backgroundColor: t.color.surfaceAlt, borderRadius: t.radius.sm }]}>
                    <Text variant="caption" tone="secondary">
                      {item.transcript}
                    </Text>
                  </View>

                  <View style={styles.metaRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, marginRight: 8 }}>
                      <Icon name="location" size={12} color={t.color.textMuted} />
                      <PlaceLabel
                        lat={item.caller_lat}
                        lng={item.caller_lng}
                        fallback={`${item.caller_lat.toFixed(4)}, ${item.caller_lng.toFixed(4)}`}
                        variant="caption"
                        tone="muted"
                        style={{ flex: 1 }}
                      />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Icon name="time" size={12} color={t.color.textMuted} />
                      <Text variant="caption" tone="muted">
                        {formatTime(item.created_at)}
                      </Text>
                    </View>
                  </View>

                  {/* AI authenticity verdict + caller's proof photo */}
                  <CallEvidence call={item} />

                  {item.status !== 'closed' && (
                    <View style={{ marginTop: t.spacing.md }}>
                      {!meAcknowledged ? (
                        <Button label="Acknowledge + route to caller" variant="danger" icon="route" loading={busy} onPress={() => acknowledgeAndRoute(item)} />
                      ) : (
                        <Button label="Mark resolved" variant="secondary" icon="resolved" loading={busy} onPress={() => closeCall(item)} />
                      )}
                    </View>
                  )}

                  {item.responders && item.responders.length > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: t.spacing.md }}>
                      <Text variant="caption" tone="muted">
                        Acknowledged by
                      </Text>
                      {item.responders.map((r, i) => (
                        <Badge key={i} label={r.sub_role} icon={serviceIcon(SUBROLE_TO_SERVICE[r.sub_role])} tone="success" />
                      ))}
                    </View>
                  )}
                  {item.status === 'closed' && item.closed_at && (
                    <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
                      Closed at {formatTime(item.closed_at)}
                    </Text>
                  )}
                </Card>
              );

              if (item.status !== 'closed') return cardBody;

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
                    if (openSwipeRef.current && openSwipeRef.current !== swipeRefs.current.get(item.id)) {
                      openSwipeRef.current.close();
                    }
                    openSwipeRef.current = swipeRefs.current.get(item.id) ?? null;
                  }}
                  onSwipeableOpen={() => clearOne(item.id)}
                >
                  {cardBody}
                </Swipeable>
              );
            }}
          />
        )}
      </GestureHandlerRootView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabRow: { flexDirection: 'row', gap: 10, marginBottom: 14, marginTop: 4 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 12, borderWidth: 1.5, minHeight: 44 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  transcript: { padding: 10, marginBottom: 10 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  removeAction: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12, width: 96 },
});
