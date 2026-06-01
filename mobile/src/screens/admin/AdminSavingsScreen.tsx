// Admin: Lives / Infrastructure / Money saved.
// Tapping a tile fetches an AI-generated insight from the backend.

import React, { useEffect, useState } from 'react';
import { Modal, RefreshControl, ScrollView, StyleSheet, View, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '@/components/Screen';
import { api, SavingsInsight, SavingsSummary } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, StatTile, IconBadge, Icon, SkeletonCard, IconName } from '@/components/ui';

type Metric = 'lives' | 'infrastructure' | 'money';

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

export default function AdminSavingsScreen() {
  const t = useTheme();
  const navigation = useNavigation<any>();
  const [summary, setSummary] = useState<SavingsSummary | null>(null);
  const [injured, setInjured] = useState<{ injured_estimate: number; contributing_events: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeMetric, setActiveMetric] = useState<Metric | null>(null);
  const [insight, setInsight] = useState<SavingsInsight | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  const METRIC_ACCENT: Record<Metric, string> = {
    lives: t.color.success,
    infrastructure: t.color.info,
    money: t.color.warning,
  };

  const load = async () => {
    setRefreshing(true);
    try {
      const [s, i] = await Promise.all([api.savingsSummary().catch(() => null), api.statsInjured().catch(() => null)]);
      if (s) setSummary(s);
      if (i) setInjured(i);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const h = setInterval(load, 8000);
    return () => clearInterval(h);
  }, []);

  const openInsight = async (metric: Metric) => {
    setActiveMetric(metric);
    setInsight(null);
    setLoadingInsight(true);
    try {
      setInsight(await api.savingsInsight(metric));
    } catch {
      setInsight({ title: 'Insight unavailable', summary: 'Could not reach the AI insight service.', highlights: [] });
    } finally {
      setLoadingInsight(false);
    }
  };

  return (
    <Screen title="Impact" subtitle="What the Sentinel-City AI agents have preserved. Tap a tile for the AI's full reasoning." scroll={false}>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.color.primary} />}
      >
        {summary ? (
          <>
            <StatTile label="Lives saved" value={summary.lives_saved.toLocaleString()} accent={METRIC_ACCENT.lives} icon="shield" onPress={() => openInsight('lives')} />
            <StatTile
              label="Injured (active events)"
              value={
                injured
                  ? `${injured.injured_estimate.toLocaleString()}${injured.contributing_events > 0 ? ` · ${injured.contributing_events} event${injured.contributing_events === 1 ? '' : 's'}` : ''}`
                  : '—'
              }
              accent={t.color.danger}
              icon="alert"
              onPress={() => openInsight('lives')}
            />
            <StatTile label="Infrastructure value preserved" value={formatUsd(summary.infrastructure_value_usd)} accent={METRIC_ACCENT.infrastructure} icon="infrastructure" onPress={() => openInsight('infrastructure')} />
            <StatTile label="Operational money saved" value={formatUsd(summary.money_saved_usd)} accent={METRIC_ACCENT.money} icon="impact" onPress={() => openInsight('money')} />
            <Card
              onPress={() => navigation.navigate('Heatmap')}
              accent={t.color.info}
              style={{ marginBottom: t.spacing.md }}
              accessibilityLabel="Open the City Resilience Heatmap"
              accessibilityHint="Shows casualty and damage hotspots with AI recommendations"
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
                <IconBadge name="map" color={t.color.info} size={44} />
                <View style={{ flex: 1 }}>
                  <Text variant="label" tone="secondary">
                    City Resilience Heatmap
                  </Text>
                  <Text variant="body" style={{ marginTop: 2 }}>
                    Casualty &amp; damage hotspots + AI advice
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={t.color.textMuted} />
              </View>
            </Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: t.spacing.sm }}>
              <Icon name="time" size={12} color={t.color.textMuted} />
              <Text variant="caption" tone="muted">
                As of {new Date(summary.as_of).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · updated by the prediction agent
              </Text>
            </View>
          </>
        ) : (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}
      </ScrollView>

      <Modal visible={activeMetric !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setActiveMetric(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
          <View style={[styles.modalHeader, { borderBottomColor: t.color.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="sparkles" size={16} color={t.color.primary} />
              <Text variant="overline" tone="accent">
                AI Insight
              </Text>
            </View>
            <Pressable onPress={() => setActiveMetric(null)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close insight">
              <Icon name="close" size={24} color={t.color.textSecondary} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: t.spacing.xl }}>
            {loadingInsight && (
              <View style={{ gap: 12 }}>
                <SkeletonCard />
                <SkeletonCard />
              </View>
            )}
            {insight && !loadingInsight && (
              <>
                <Text variant="title">{insight.title}</Text>
                <Text variant="body" tone="secondary" style={{ marginTop: t.spacing.md }}>
                  {insight.summary}
                </Text>
                {insight.highlights.length > 0 && (
                  <Card style={{ marginTop: t.spacing.xl }}>
                    <Text variant="overline" tone="muted" style={{ marginBottom: t.spacing.sm }}>
                      Key drivers
                    </Text>
                    {insight.highlights.map((h, i) => (
                      <View key={i} style={{ flexDirection: 'row', gap: 8, marginTop: i === 0 ? 0 : 8 }}>
                        <IconBadge name="check-circle" color={t.color.success} size={24} iconSize={14} />
                        <Text variant="body" style={{ flex: 1 }}>
                          {h}
                        </Text>
                      </View>
                    ))}
                  </Card>
                )}
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
});
