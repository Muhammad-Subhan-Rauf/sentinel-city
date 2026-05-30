// Admin: AI Agent Details — the registry of AI agents driving the city.

import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { api, Agent } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Badge, IconBadge, Divider, SkeletonCard, EmptyState } from '@/components/ui';

export default function AdminAgentsScreen() {
  const t = useTheme();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);

  const load = async () => {
    setRefreshing(true);
    try {
      setAgents(await api.listAgents().catch(() => []));
    } finally {
      setRefreshing(false);
      setFirstLoad(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Screen title="AI Agents" subtitle="The autonomous agents coordinating the city's response, with a snapshot of each one's latest behaviour." scroll={false}>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.color.primary} />}
      >
        {firstLoad ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : agents.length === 0 ? (
          <EmptyState icon="agents" tone={t.color.admin} title="No agents registered" body="Active AI agents will appear here as they come online." />
        ) : (
          agents.map((a) => (
            <Card key={a.id} style={{ marginBottom: t.spacing.md }}>
              <View style={styles.head}>
                <IconBadge name="agents" color={t.color.admin} size={44} />
                <View style={{ flex: 1, marginHorizontal: t.spacing.md }}>
                  <Text variant="h3">{a.name}</Text>
                  <Text variant="caption" tone="secondary">
                    {a.role}
                  </Text>
                </View>
                <Badge label={a.status} tone="success" icon="radio" />
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: t.spacing.sm }}>
                <Text variant="caption" tone="muted">
                  Powered by
                </Text>
                <Badge label={a.model} tone="accent" icon="sparkles" />
              </View>

              <Divider style={{ marginVertical: t.spacing.md }} />

              <Text variant="overline" tone="muted">
                Most recent action
              </Text>
              <Text variant="body" style={{ marginTop: 4 }}>
                {a.last_action}
              </Text>

              <View style={styles.metricsRow}>
                {Object.entries(a.metrics).map(([k, v]) => (
                  <View key={k} style={[styles.metricBox, { backgroundColor: t.color.surfaceAlt, borderRadius: t.radius.md }]}>
                    <Text variant="h2" tone="info" style={{ fontVariant: ['tabular-nums'] }}>
                      {v.toLocaleString()}
                    </Text>
                    <Text variant="caption" tone="secondary" style={{ marginTop: 2, textTransform: 'capitalize' }}>
                      {k.replace(/_/g, ' ')}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  metricsRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  metricBox: { flex: 1, minWidth: 100, padding: 12 },
});
