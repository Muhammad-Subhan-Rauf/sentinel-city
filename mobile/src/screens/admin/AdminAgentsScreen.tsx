// Admin: AI Agent Details — the registry of mock AI agents driving the city.

import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { api, Agent } from '@/lib/api';
import { colors } from '@/lib/colors';

export default function AdminAgentsScreen() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      setAgents(await api.listAgents().catch(() => []));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Screen title="AI Agents">
      <Text style={styles.subtitle}>
        Mock registry — these slots will be filled by live AI models. Each card shows what the agent does
        and a snapshot of its latest behaviour.
      </Text>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />}
      >
        {agents.map((a) => (
          <View key={a.id} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardName}>{a.name}</Text>
              <View style={styles.statusPill}>
                <View style={styles.statusDot} />
                <Text style={styles.statusText}>{a.status}</Text>
              </View>
            </View>
            <Text style={styles.role}>{a.role}</Text>
            <Text style={styles.model}>Powered by · {a.model}</Text>
            <View style={styles.divider} />
            <Text style={styles.actionLabel}>Most recent action</Text>
            <Text style={styles.action}>{a.last_action}</Text>

            <View style={styles.metricsRow}>
              {Object.entries(a.metrics).map(([k, v]) => (
                <View key={k} style={styles.metricBox}>
                  <Text style={styles.metricValue}>{v.toLocaleString()}</Text>
                  <Text style={styles.metricLabel}>{k.replace(/_/g, ' ')}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', flex: 1 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: `${colors.success}22`,
    borderColor: colors.success,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  statusText: { color: colors.success, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  role: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  model: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
  actionLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', marginBottom: 2 },
  action: { color: colors.textPrimary, fontSize: 13, lineHeight: 18 },
  metricsRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  metricBox: {
    flex: 1,
    minWidth: 100,
    backgroundColor: colors.surfaceAlt,
    padding: 10,
    borderRadius: 8,
  },
  metricValue: { color: colors.info, fontSize: 18, fontWeight: '700' },
  metricLabel: { color: colors.textSecondary, fontSize: 11, marginTop: 2, textTransform: 'capitalize' },
});
