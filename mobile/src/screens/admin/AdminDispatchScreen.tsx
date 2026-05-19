// Admin: Dispatch Details — who's on duty, where, doing what.

import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { api, FireStation, MobileWorker } from '@/lib/api';
import { colors } from '@/lib/colors';

const STATUS_COLOR: Record<MobileWorker['status'], string> = {
  available: colors.success,
  dispatched: colors.warning,
  on_scene: colors.danger,
  off_duty: colors.textMuted,
};

const ROLE_ICON: Record<MobileWorker['role'], string> = {
  firefighter: '🚒',
  paramedic: '🚑',
  police: '🚓',
};

export default function AdminDispatchScreen() {
  const [workers, setWorkers] = useState<MobileWorker[]>([]);
  const [stations, setStations] = useState<FireStation[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [w, s] = await Promise.all([
        api.listWorkers().catch(() => []),
        api.listFireStations().catch(() => []),
      ]);
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

  return (
    <Screen title="Dispatch">
      <Text style={styles.subtitle}>Live roster of emergency workers in the field.</Text>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />}
      >
        <View style={styles.statRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{workers.length}</Text>
            <Text style={styles.statLabel}>On duty</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: colors.warning }]}>{byStatus.dispatched ?? 0}</Text>
            <Text style={styles.statLabel}>Dispatched</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: colors.danger }]}>{byStatus.on_scene ?? 0}</Text>
            <Text style={styles.statLabel}>On scene</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: colors.info }]}>{stations.length}</Text>
            <Text style={styles.statLabel}>Stations</Text>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Workers</Text>
        {workers.map((w) => (
          <View key={w.id} style={styles.card}>
            <Text style={styles.cardIcon}>{ROLE_ICON[w.role]}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{w.name}</Text>
              <Text style={styles.cardRole}>
                {w.role} · {w.lat.toFixed(3)}, {w.lng.toFixed(3)}
              </Text>
            </View>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: `${STATUS_COLOR[w.status]}22`, borderColor: STATUS_COLOR[w.status] },
              ]}
            >
              <Text style={[styles.statusPillText, { color: STATUS_COLOR[w.status] }]}>
                {w.status.replace('_', ' ')}
              </Text>
            </View>
          </View>
        ))}

        {stations.length > 0 && (
          <>
            <Text style={styles.sectionHeader}>Fire Stations</Text>
            {stations.map((s) => {
              const dispatched = s.trucks_dispatched ?? 0;
              const total = s.truck_count ?? 0;
              const ratio = total > 0 ? dispatched / total : 0;
              const trucksColor =
                total > 0 && dispatched >= total
                  ? colors.danger
                  : ratio >= 0.75
                  ? colors.warning
                  : colors.success;
              return (
                <View key={s.id} style={styles.card}>
                  <Text style={styles.cardIcon}>🏛️</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{s.name ?? 'Unnamed station'}</Text>
                    <Text style={styles.cardRole}>
                      {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusPill,
                      { backgroundColor: `${trucksColor}22`, borderColor: trucksColor },
                    ]}
                  >
                    <Text style={[styles.statusPillText, { color: trucksColor }]}>
                      🚒 {dispatched}/{total}
                    </Text>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12 },
  statRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  statBox: {
    flex: 1,
    minWidth: 70,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  statValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '800' },
  statLabel: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  sectionHeader: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 8 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardIcon: { fontSize: 22 },
  cardName: { color: colors.textPrimary, fontWeight: '600' },
  cardRole: { color: colors.textSecondary, fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  statusPillText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
});
