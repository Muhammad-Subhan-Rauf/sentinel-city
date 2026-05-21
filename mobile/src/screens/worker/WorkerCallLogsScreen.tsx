// Worker-side 911 call log. Read-only view of citizen-placed emergency calls
// scoped by service. Acknowledging a call is just a status update — the AI
// monitoring loop owns the actual dispatch decision and pushes orders via
// /api/me/dispatch (consumed by WorkerMapScreen). This screen does NOT route.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import {
  api,
  EmergencyCall,
  EmergencyService,
  SUBROLE_TO_SERVICE,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';

const POLL_MS = 4000;

// Per-(user, sub-role) storage key. Two responders sharing a phone (or one
// person switching from police to paramedic during a shift) each keep their
// own cleared list — clearing history on one role doesn't affect the other.
const CLEARED_CALLS_KEY = (userId: string, subRole: string) =>
  `sentinel.cleared-calls.v1:${userId}:${subRole}`;

const STATUS_TONE: Record<EmergencyCall['status'], string> = {
  new: colors.danger,
  acknowledged: colors.warning ?? '#d97706',
  closed: colors.textMuted,
};

const SERVICE_ICON: Record<EmergencyService, string> = {
  ambulance: '🚑',
  police: '🚓',
  firefighter: '🚒',
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

export default function WorkerCallLogsScreen() {
  const { session } = useAuth();
  const [calls, setCalls] = useState<EmergencyCall[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Resolve "which service am I" once per session. Defensive default: police.
  const subRole = (session?.role === 'worker' ? session?.sub_role : undefined) ?? 'police';
  const service: EmergencyService = SUBROLE_TO_SERVICE[subRole as keyof typeof SUBROLE_TO_SERVICE] ?? 'police';
  const serviceIcon = SERVICE_ICON[service];

  // Cleared (= swiped-away) history call IDs. Survives app restarts via
  // AsyncStorage so a responder's clean inbox stays clean on next launch.
  // Only the History tab honours this set — Active dispatches are never
  // hidden, even if their underlying call id is in the cleared set.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const storageKey = session ? CLEARED_CALLS_KEY(session.userId, subRole) : null;
  const swipeRefs = useRef<Map<string, Swipeable>>(new Map());
  const openSwipeRef = useRef<Swipeable | null>(null);

  // Load persisted clears on mount / when sub-role changes.
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
      // Close any open swipes so the row animations don't snap weirdly.
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
    }
  }, [service]);

  useEffect(() => {
    load();
    const handle = setInterval(load, POLL_MS);
    return () => clearInterval(handle);
  }, [load]);

  // Status updates only. The worker tells the system "I see this call" — the
  // actual dispatch (target, route, units) is the AI's call and arrives via
  // /api/me/dispatch on the Map tab. This avoids the client picking which
  // worker takes which call.
  const acknowledge = async (call: EmergencyCall) => {
    if (!session) return;
    setBusyId(call.id);
    try {
      const updated = await api.updateEmergencyCall(call.id, {
        status: 'acknowledged',
        worker_id: session.userId,
        sub_role: subRole as 'paramedic' | 'police' | 'firefighter',
      });
      setCalls((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
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
    } catch {
      /* ignore */
    } finally {
      setBusyId(null);
    }
  };

  // Local tab state: "active" is new + acknowledged; "history" is closed.
  // Splitting the feed keeps the active screen short during a busy shift —
  // closed calls don't push live ones below the fold.
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const { activeCalls, historyCalls, newCount, hiddenHistoryCount } = useMemo(() => {
    const active: EmergencyCall[] = [];
    const historyAll: EmergencyCall[] = [];
    for (const c of calls) {
      if (c.status === 'closed') historyAll.push(c);
      else active.push(c);
    }
    // History honours the per-worker cleared set; active dispatches never do.
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
      `This hides ${historyCalls.length} resolved call${historyCalls.length === 1 ? '' : 's'} from your view. They stay on the server for audit — you can clear them on other devices independently.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => clearAllHistory(historyCalls.map((c) => c.id)),
        },
      ],
    );
  };

  // Swipe-right reveals a red "Clear" affordance behind the row. Mirrors
  // the citizen NotificationsScreen pattern so the gesture feels consistent.
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
        <Text style={styles.removeActionText}>Clear</Text>
      </Animated.View>
    );
  };

  return (
    <Screen title={`${serviceIcon} 911 Call Log`} scroll={false}>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <Text style={styles.subtitle}>
        Showing {service} calls only ·{' '}
        {newCount > 0 ? `${newCount} awaiting response` : 'no new calls'}
        {' '}· refreshes every {POLL_MS / 1000}s
      </Text>

      {/* Active / History segmented control. Active tab gets a red accent so
          a responder can tell at a glance whether they're looking at live
          dispatch or the archive. History uses the neutral info colour. */}
      <View style={styles.tabRow}>
        <Pressable
          onPress={() => setTab('active')}
          style={({ pressed }) => [
            styles.tabBtn,
            tab === 'active' && styles.tabBtnActiveOn,
            pressed && styles.tabBtnPressed,
          ]}
        >
          <Text style={styles.tabIcon}>🚨</Text>
          <View style={styles.tabLabelCol}>
            <Text style={[styles.tabLabel, tab === 'active' && styles.tabLabelOn]}>
              Active
            </Text>
          </View>
          <View
            style={[
              styles.countBadge,
              tab === 'active' && styles.countBadgeActiveOn,
            ]}
          >
            <Text
              style={[
                styles.countBadgeText,
                tab === 'active' && styles.countBadgeTextOn,
              ]}
            >
              {activeCalls.length}
            </Text>
          </View>
        </Pressable>

        <Pressable
          onPress={() => setTab('history')}
          style={({ pressed }) => [
            styles.tabBtn,
            tab === 'history' && styles.tabBtnHistoryOn,
            pressed && styles.tabBtnPressed,
          ]}
        >
          <Text style={styles.tabIcon}>🗂️</Text>
          <View style={styles.tabLabelCol}>
            <Text style={[styles.tabLabel, tab === 'history' && styles.tabLabelOn]}>
              History
            </Text>
          </View>
          <View
            style={[
              styles.countBadge,
              tab === 'history' && styles.countBadgeHistoryOn,
            ]}
          >
            <Text
              style={[
                styles.countBadgeText,
                tab === 'history' && styles.countBadgeTextOn,
              ]}
            >
              {historyCalls.length}
            </Text>
          </View>
        </Pressable>
      </View>

      <FlatList
        style={{ flex: 1 }}
        data={visibleCalls}
        keyExtractor={(c) => c.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {tab === 'active' ? (
              <>
                <Text style={styles.emptyText}>No active {service} calls.</Text>
                <Text style={styles.emptyMuted}>
                  Citizens inside an active disaster zone can request {service} from their 911
                  dialog. Their call will appear here in real time.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyText}>No resolved calls yet.</Text>
                <Text style={styles.emptyMuted}>
                  Closed calls land here for the rest of the shift, so you can look back
                  at recent dispatches.
                </Text>
              </>
            )}
          </View>
        }
        ListFooterComponent={
          tab === 'history' && historyCalls.length > 0 ? (
            <Pressable onPress={confirmClearAll} style={styles.clearAllFooter}>
              <Text style={styles.clearAllFooterText}>
                Clear all {historyCalls.length} resolved call{historyCalls.length === 1 ? '' : 's'}
              </Text>
            </Pressable>
          ) : tab === 'history' && hiddenHistoryCount > 0 ? (
            <Text style={styles.clearAllHint}>
              {hiddenHistoryCount} hidden call{hiddenHistoryCount === 1 ? '' : 's'} — cleared from this device.
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const tone = STATUS_TONE[item.status];
          const busy = busyId === item.id;
          const meAcknowledged = item.responders?.some((r) => r.worker_id === session?.userId);
          // Card body, shared by both branches below.
          const cardBody = (
            <View style={[styles.card, { borderLeftColor: tone }]}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.disasterLine}>
                    {item.disaster_type.replace(/_/g, ' ')} · sev {item.severity}
                  </Text>
                  <Text style={styles.callerLine}>Caller: {item.citizen_name}</Text>
                </View>
                <View style={[styles.statusPill, { borderColor: tone }]}>
                  <Text style={[styles.statusPillText, { color: tone }]}>
                    {item.status.toUpperCase()}
                  </Text>
                </View>
              </View>

              {/* Service tags */}
              <View style={styles.tagRow}>
                {item.requested_services.map((s) => (
                  <View
                    key={s}
                    style={[
                      styles.serviceTag,
                      s === service && styles.serviceTagMe,
                    ]}
                  >
                    <Text style={[styles.serviceTagText, s === service && styles.serviceTagTextMe]}>
                      {SERVICE_ICON[s]} {s}
                    </Text>
                  </View>
                ))}
              </View>

              <Text style={styles.transcript}>{item.transcript}</Text>

              <View style={styles.metaRow}>
                <Text style={styles.metaText}>
                  📍 {item.caller_lat.toFixed(5)}, {item.caller_lng.toFixed(5)}
                </Text>
                <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
              </View>

              {item.status !== 'closed' && (
                <View style={styles.actionRow}>
                  {!meAcknowledged && (
                    <Pressable
                      disabled={busy}
                      onPress={() => acknowledge(item)}
                      style={[styles.actionBtn, styles.ackBtn, busy && styles.actionBtnDisabled]}
                    >
                      <Text style={styles.actionBtnText}>Acknowledge</Text>
                    </Pressable>
                  )}
                  {meAcknowledged && (
                    <Pressable
                      disabled={busy}
                      onPress={() => closeCall(item)}
                      style={[styles.actionBtn, styles.closeBtn, busy && styles.actionBtnDisabled]}
                    >
                      <Text style={styles.actionBtnText}>Mark resolved</Text>
                    </Pressable>
                  )}
                  {busy && <ActivityIndicator color={colors.info} style={{ marginLeft: 8 }} />}
                </View>
              )}

              {item.responders && item.responders.length > 0 && (
                <Text style={styles.footnote}>
                  Acknowledged by{' '}
                  {item.responders.map((r) => `${SERVICE_ICON[SUBROLE_TO_SERVICE[r.sub_role]]} ${r.sub_role}`).join(', ')}
                </Text>
              )}
              {item.status === 'closed' && item.closed_at && (
                <Text style={styles.footnote}>Closed at {formatTime(item.closed_at)}</Text>
              )}
            </View>
          );

          // Active dispatches never get a swipe affordance — a responder
          // mid-shift shouldn't accidentally hide a live call. History rows
          // (status === 'closed') wrap in Swipeable so they can be cleared.
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
                // Single-open policy: close any previously-open swipe so the
                // user can never have two "Clear" affordances dangling at once.
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
      </GestureHandlerRootView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12, fontSize: 12 },
  tabRow: {
    flexDirection: 'row',
    marginBottom: 14,
    gap: 10,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    // Subtle elevation so the tabs read as cards, not chips.
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  tabBtnPressed: { opacity: 0.78 },
  // Active tab uses the danger red — visually telegraphs "live, urgent".
  tabBtnActiveOn: {
    backgroundColor: 'rgba(220,38,38,0.12)',
    borderColor: colors.danger,
  },
  // History tab uses the neutral info accent — calmer, archival feel.
  tabBtnHistoryOn: {
    backgroundColor: 'rgba(59,130,246,0.10)',
    borderColor: colors.info,
  },
  tabIcon: { fontSize: 22, lineHeight: 26 },
  tabLabelCol: { flex: 1 },
  tabLabel: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  tabLabelOn: { color: colors.textPrimary },
  // Count chip on each tab. Inactive: faint outline; active: filled accent.
  countBadge: {
    minWidth: 28,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeActiveOn: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  countBadgeHistoryOn: {
    backgroundColor: colors.info,
    borderColor: colors.info,
  },
  countBadgeText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  countBadgeTextOn: { color: '#fff' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  disasterLine: { color: colors.textPrimary, fontWeight: '700', fontSize: 15 },
  callerLine: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusPillText: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  serviceTag: {
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  serviceTagMe: { borderColor: colors.info, backgroundColor: 'rgba(59,130,246,0.10)' },
  serviceTagText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  serviceTagTextMe: { color: colors.info },
  transcript: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    backgroundColor: colors.bg,
    padding: 10,
    borderRadius: 8,
    marginBottom: 8,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  metaText: { color: colors.textMuted, fontSize: 11, fontVariant: ['tabular-nums'] },
  actionRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  actionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  ackBtn: { backgroundColor: colors.info },
  closeBtn: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  actionBtnDisabled: { opacity: 0.5 },
  actionBtnText: { color: colors.textPrimary, fontWeight: '600', fontSize: 13 },
  footnote: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 16 },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  emptyMuted: { color: colors.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center' },
  // Swipe-reveal: the red "Clear" pane that slides in behind a history row
  // as the user drags it left. Mirrors NotificationsScreen so muscle memory
  // is consistent across the app.
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
  clearAllFooter: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  clearAllFooterText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  clearAllHint: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 10,
  },
});
