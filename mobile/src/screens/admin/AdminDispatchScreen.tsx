// Admin: Dispatch Details — who's on duty, where, doing what.

import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { api, FireStation, MobileWorker } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Badge, IconBadge, Icon, SectionHeader, IconName, BadgeTone } from '@/components/ui';

const STATUS_TONE: Record<MobileWorker['status'], BadgeTone> = {
  available: 'success',
  dispatched: 'warning',
  on_scene: 'danger',
  off_duty: 'neutral',
};

const ROLE_ICON: Record<MobileWorker['role'], IconName> = {
  firefighter: 'firefighter',
  paramedic: 'ambulance',
  police: 'police',
};

export default function AdminDispatchScreen() {
  const t = useTheme();
  const [workers, setWorkers] = useState<MobileWorker[]>([]);
  const [stations, setStations] = useState<FireStation[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [w, s] = await Promise.all([api.listWorkers().catch(() => []), api.listFireStations().catch(() => [])]);
      setWorkers(w);
      setStations(s);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, []);

  const byStatus = workers.reduce<Record<string, number>>((acc, w) => {
    acc[w.status] = (acc[w.status] ?? 0) + 1;
    return acc;
  }, {});

  const roleAccent = (role: MobileWorker['role']) =>
    role === 'firefighter' ? t.color.firefighter : role === 'police' ? t.color.police : t.color.paramedic;

  const stats: Array<{ label: string; value: number; color: string }> = [
    { label: 'On duty', value: workers.length, color: t.color.primary },
    { label: 'Dispatched', value: byStatus.dispatched ?? 0, color: t.color.warning },
    { label: 'On scene', value: byStatus.on_scene ?? 0, color: t.color.danger },
    { label: 'Stations', value: stations.length, color: t.color.info },
  ];

  return (
    <Screen title="Dispatch" subtitle="Live roster of emergency workers in the field." scroll={false}>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.color.primary} />}
      >
        <View style={styles.statRow}>
          {stats.map((s) => (
            <Card key={s.label} padded={false} style={{ flex: 1, minWidth: 70, paddingVertical: t.spacing.md, alignItems: 'center' }}>
              <Text variant="h1" color={s.color} style={{ fontVariant: ['tabular-nums'] }}>
                {s.value}
              </Text>
              <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                {s.label}
              </Text>
            </Card>
          ))}
        </View>

        <SectionHeader title="Workers" hint={`${workers.length} in the field`} style={{ marginTop: t.spacing.lg }} />
        {workers.map((w) => (
          <Card key={w.id} accent={roleAccent(w.role)} style={styles.row}>
            <IconBadge name={ROLE_ICON[w.role]} color={roleAccent(w.role)} size={42} />
            <View style={{ flex: 1, marginHorizontal: t.spacing.md }}>
              <Text variant="bodyStrong">{w.name}</Text>
              <Text variant="caption" tone="muted" style={{ marginTop: 2, fontFamily: t.fonts.mono }}>
                {w.role} · {w.lat.toFixed(3)}, {w.lng.toFixed(3)}
              </Text>
            </View>
            <Badge label={w.status.replace('_', ' ')} tone={STATUS_TONE[w.status]} />
          </Card>
        ))}

        {stations.length > 0 && (
          <>
            <SectionHeader title="Fire Stations" hint={`${stations.length} active`} style={{ marginTop: t.spacing.lg }} />
            {stations.map((s) => {
              const dispatched = s.trucks_dispatched ?? 0;
              const total = s.truck_count ?? 0;
              const ratio = total > 0 ? dispatched / total : 0;
              const tone: BadgeTone = total > 0 && dispatched >= total ? 'danger' : ratio >= 0.75 ? 'warning' : 'success';
              return (
                <Card key={s.id} style={styles.row}>
                  <IconBadge name="infrastructure" color={t.color.info} size={42} />
                  <View style={{ flex: 1, marginHorizontal: t.spacing.md }}>
                    <Text variant="bodyStrong">{s.name ?? 'Unnamed station'}</Text>
                    <Text variant="caption" tone="muted" style={{ marginTop: 2, fontFamily: t.fonts.mono }}>
                      {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                    </Text>
                  </View>
                  <Badge label={`${dispatched}/${total}`} icon="firefighter" tone={tone} />
                </Card>
              );
            })}
          </>
        )}
        {workers.length === 0 && stations.length === 0 && !refreshing && (
          <View style={{ paddingTop: t.spacing.xxl, alignItems: 'center' }}>
            <Icon name="people" size={32} color={t.color.textMuted} />
            <Text variant="body" tone="muted" style={{ marginTop: 8 }}>
              No workers on duty yet.
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
});
