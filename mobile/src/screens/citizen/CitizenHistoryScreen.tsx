// Citizen "History" tab — the personal record of every 911 call this citizen
// has placed through the app, with the current status (waiting / responders
// en route / resolved), which services were requested, and a low-key
// authenticity verdict line from the AI prank-check pipeline.
//
// The list endpoint doesn't accept a per-citizen filter, so we fetch and
// filter client-side by session.userId. Pull-to-refresh and a 10s background
// poll keep status pills fresh while the screen is open.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
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

  const counts = useMemo(() => {
    const c = { open: 0, total: 0 };
    if (!calls) return c;
    c.total = calls.length;
    c.open = calls.filter((x) => x.status !== 'closed').length;
    return c;
  }, [calls]);

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

  return (
    <Screen title="History" subtitle={subtitle} scroll={false}>
      <FlatList
        data={calls}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingTop: t.spacing.xs, paddingBottom: t.spacing.xxxl }}
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
        renderItem={({ item }) => <CallRow call={item} />}
      />
    </Screen>
  );
}

function CallRow({ call }: { call: EmergencyCall }) {
  const t = useTheme();
  const status = statusMeta(call.status);
  const ai = aiBadge(call);

  return (
    <Card elevation={1}>
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
        <Badge tone={status.tone} label={status.label} />
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
