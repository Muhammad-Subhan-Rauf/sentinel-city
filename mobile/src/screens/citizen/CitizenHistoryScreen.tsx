// Citizen "History" tab — the personal record of every 911 call this citizen
// has placed through the app, with the current status (waiting / responders
// en route / resolved), which services were requested, and a low-key
// authenticity verdict line from the AI prank-check pipeline.
//
// The list endpoint doesn't accept a per-citizen filter, so we fetch and
// filter client-side by session.userId. Pull-to-refresh and a 10s background
// poll keep status pills fresh while the screen is open.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Screen } from '@/components/Screen';
import {
  Text,
  Card,
  Badge,
  BadgeTone,
  Icon,
  EmptyState,
  SkeletonCard,
  serviceIcon,
} from '@/components/ui';
import { useTheme } from '@/theme';
import { useAuth } from '@/lib/auth';
import { api, EmergencyCall, EmergencyService } from '@/lib/api';
import { CaseDetailModal } from '@/components/CaseDetailModal';

type HistoryTab = 'active' | 'past';

type StatusMeta = { tone: BadgeTone; label: string };

function statusMeta(status: EmergencyCall['status']): StatusMeta {
  switch (status) {
    case 'new':
      return { tone: 'warning', label: 'Awaiting dispatch' };
    case 'acknowledged':
      return { tone: 'info', label: 'Responders en route' };
    case 'closed':
      return { tone: 'success', label: 'Resolved' };
  }
}

function headline(call: EmergencyCall): string {
  if (call.is_direct) {
    return call.category ? `${call.category} — SOS` : 'Direct SOS';
  }
  return call.disaster_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (sameDay) return `Today ${hh}:${mm}`;
  if (isYesterday) return `Yesterday ${hh}:${mm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` · ${hh}:${mm}`;
}

function aiBadge(call: EmergencyCall): { tone: BadgeTone; label: string } | null {
  const a = call.ai_assessment;
  if (!a) return null;
  if (a.status === 'analyzing') return { tone: 'neutral', label: 'AI reviewing' };
  if (a.status === 'unavailable') return null;
  if (a.verdict === 'genuine') return { tone: 'success', label: 'Verified genuine' };
  if (a.verdict === 'likely_prank') return { tone: 'danger', label: 'Flagged' };
  return { tone: 'neutral', label: 'Unverified' };
}

export default function CitizenHistoryScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const [calls, setCalls] = useState<EmergencyCall[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<HistoryTab>('active');
  const [selected, setSelected] = useState<EmergencyCall | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const all = await api.listEmergencyCalls({ statusFilter: 'all' });
      const mine = all
        .filter((c) => c.citizen_id === session.userId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      setCalls(mine);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your history right now.');
      setCalls((prev) => prev ?? []);
    }
  }, [session]);

  useEffect(() => {
    load();
    const handle = setInterval(load, 10_000);
    return () => clearInterval(handle);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const { activeCalls, pastCalls } = useMemo(() => {
    const active: EmergencyCall[] = [];
    const past: EmergencyCall[] = [];
    for (const c of calls ?? []) (c.status === 'closed' ? past : active).push(c);
    return { activeCalls: active, pastCalls: past };
  }, [calls]);

  const counts = useMemo(() => {
    const c = { open: 0, total: 0 };
    if (!calls) return c;
    c.total = calls.length;
    c.open = calls.filter((x) => x.status !== 'closed').length;
    return c;
  }, [calls]);

  // Keep the open detail modal in sync with freshly-polled data.
  const selectedLive = selected ? (calls?.find((c) => c.id === selected.id) ?? selected) : null;

  const subtitle =
    calls === null
      ? 'Loading your call history…'
      : counts.total === 0
        ? 'No 911 calls placed yet.'
        : counts.open > 0
          ? `${counts.total} total · ${counts.open} still active`
          : `${counts.total} total · all resolved`;

  if (!session) return null;

  // Loading skeletons on first paint.
  if (calls === null) {
    return (
      <Screen title="History" subtitle={subtitle}>
        <SkeletonCard />
        <View style={{ height: 12 }} />
        <SkeletonCard />
        <View style={{ height: 12 }} />
        <SkeletonCard />
      </Screen>
    );
  }

  if (calls.length === 0) {
    return (
      <Screen title="History" subtitle={subtitle}>
        {error ? (
          <Text variant="caption" tone="danger" style={{ marginBottom: t.spacing.sm }}>
            {error}
          </Text>
        ) : null}
        <EmptyState
          icon="history"
          title="No calls yet"
          body="When you place a 911 call from the app, it'll show up here so you can track the response."
        />
      </Screen>
    );
  }

  const visible = tab === 'active' ? activeCalls : pastCalls;

  return (
    <Screen title="History" subtitle={subtitle} scroll={false} padded={false}>
      <View style={{ flex: 1, paddingHorizontal: t.spacing.lg }}>
        <View style={styles.tabRow}>
          <Segment id="active" label="Active" icon="alert" count={activeCalls.length} tone={t.color.danger} current={tab} onPress={setTab} />
          <Segment id="past" label="Done" icon="time" count={pastCalls.length} tone={t.color.primary} current={tab} onPress={setTab} />
        </View>

        <FlatList
          data={visible}
          keyExtractor={(c) => c.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: t.spacing.xs, paddingBottom: t.spacing.xxxl, flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={{ height: t.spacing.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.color.primary} />
          }
          ListHeaderComponent={
            error ? (
              <Text variant="caption" tone="danger" style={{ marginBottom: t.spacing.sm }}>
                {error}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            tab === 'active' ? (
              <EmptyState icon="shield" tone={t.color.success} title="No active cases" body="Calls you place will appear here while responders are on the way." />
            ) : (
              <EmptyState icon="time" tone={t.color.textMuted} title="No past cases" body="Resolved calls move here so you can look back on them." />
            )
          }
          renderItem={({ item }) => <CallRow call={item} onPress={() => setSelected(item)} />}
        />
      </View>

      <CaseDetailModal call={selectedLive} visible={!!selected} onClose={() => setSelected(null)} />
    </Screen>
  );
}

function Segment({
  id,
  label,
  icon,
  count,
  tone,
  current,
  onPress,
}: {
  id: HistoryTab;
  label: string;
  icon: 'alert' | 'time';
  count: number;
  tone: string;
  current: HistoryTab;
  onPress: (id: HistoryTab) => void;
}) {
  const t = useTheme();
  const on = current === id;
  return (
    <Pressable
      onPress={() => onPress(id)}
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
}

function CallRow({ call, onPress }: { call: EmergencyCall; onPress: () => void }) {
  const t = useTheme();
  const status = statusMeta(call.status);
  const ai = aiBadge(call);

  return (
    <Card elevation={1} onPress={onPress} accessibilityLabel={`${headline(call)}, ${status.label}`} accessibilityHint="Opens case details">
      <View style={styles.headerRow}>
        <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {headline(call)}
          </Text>
          <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
            {formatWhen(call.created_at)}
            {call.is_direct ? ' · direct SOS' : ''}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Badge tone={status.tone} label={status.label} />
          <Icon name="chevronRight" size={16} color={t.color.textMuted} />
        </View>
      </View>

      <View style={styles.metaRow}>
        {call.requested_services.map((svc) => (
          <ServiceChip key={svc} service={svc} />
        ))}
        {call.has_photo ? (
          <View style={[styles.chip, { borderColor: t.color.border }]}>
            <Icon name="image" size={12} color={t.color.textMuted} />
            <Text variant="caption" tone="secondary">
              Photo attached
            </Text>
          </View>
        ) : null}
      </View>

      {call.responders.length > 0 ? (
        <Text variant="caption" tone="secondary" style={{ marginTop: t.spacing.sm }}>
          {call.responders.length} responder{call.responders.length === 1 ? '' : 's'} acknowledged
          {call.acknowledged_at ? ` · first ack ${formatWhen(call.acknowledged_at)}` : ''}
        </Text>
      ) : null}

      {call.closed_at ? (
        <Text variant="caption" tone="secondary" style={{ marginTop: t.spacing.xs }}>
          Closed {formatWhen(call.closed_at)}
        </Text>
      ) : null}

      {ai ? (
        <View style={{ marginTop: t.spacing.sm, alignSelf: 'flex-start' }}>
          <Badge tone={ai.tone} label={ai.label} />
        </View>
      ) : null}
    </Card>
  );
}

function ServiceChip({ service }: { service: EmergencyService }) {
  const t = useTheme();
  const label = service === 'ambulance' ? 'Ambulance' : service === 'police' ? 'Police' : 'Fire';
  return (
    <View style={[styles.chip, { borderColor: t.color.border }]}>
      <Icon name={serviceIcon(service)} size={12} color={t.color.textMuted} />
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabRow: { flexDirection: 'row', gap: 10, marginBottom: 14, marginTop: 4 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 12, borderWidth: 1.5, minHeight: 44 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
});
