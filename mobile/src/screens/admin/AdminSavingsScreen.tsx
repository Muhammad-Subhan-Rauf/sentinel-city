// Admin: Lives / Infrastructure / Money saved.
// Tapping a tile fetches an AI-generated insight from the backend.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { StatCard } from '@/components/StatCard';
import { api, SavingsInsight, SavingsSummary } from '@/lib/api';
import { colors } from '@/lib/colors';

type Metric = 'lives' | 'infrastructure' | 'money';

const METRIC_ACCENT: Record<Metric, string> = {
  lives: colors.success,
  infrastructure: colors.info,
  money: colors.warning,
};

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

export default function AdminSavingsScreen() {
  const [summary, setSummary] = useState<SavingsSummary | null>(null);
  const [injured, setInjured] = useState<{ injured_estimate: number; contributing_events: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeMetric, setActiveMetric] = useState<Metric | null>(null);
  const [insight, setInsight] = useState<SavingsInsight | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [s, i] = await Promise.all([
        api.savingsSummary().catch(() => null),
        api.statsInjured().catch(() => null),
      ]);
      if (s) setSummary(s);
      if (i) setInjured(i);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const h = setInterval(load, 4000);
    return () => clearInterval(h);
  }, []);

  const openInsight = async (metric: Metric) => {
    setActiveMetric(metric);
    setInsight(null);
    setLoadingInsight(true);
    try {
      setInsight(await api.savingsInsight(metric));
    } catch {
      setInsight({
        title: 'Insight unavailable',
        summary: 'Could not reach the AI insight service.',
        highlights: [],
      });
    } finally {
      setLoadingInsight(false);
    }
  };

  return (
    <Screen title="Impact">
      <Text style={styles.subtitle}>
        What the Sentinel-City AI agents have preserved. Tap a tile for the AI's full reasoning.
      </Text>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />}
      >
        {summary ? (
          <>
            <StatCard
              label="Lives saved"
              value={summary.lives_saved.toLocaleString()}
              accent={METRIC_ACCENT.lives}
              onPress={() => openInsight('lives')}
            />
            <StatCard
              label="Injured (active events)"
              value={
                injured
                  ? `${injured.injured_estimate.toLocaleString()}${
                      injured.contributing_events > 0 ? ` · ${injured.contributing_events} event${injured.contributing_events === 1 ? '' : 's'}` : ''
                    }`
                  : '—'
              }
              accent={colors.danger}
              onPress={() => openInsight('lives')}
            />
            <StatCard
              label="Infrastructure value preserved"
              value={formatUsd(summary.infrastructure_value_usd)}
              accent={METRIC_ACCENT.infrastructure}
              onPress={() => openInsight('infrastructure')}
            />
            <StatCard
              label="Operational money saved"
              value={formatUsd(summary.money_saved_usd)}
              accent={METRIC_ACCENT.money}
              onPress={() => openInsight('money')}
            />
            <Text style={styles.footnote}>
              As of {new Date(summary.as_of).toLocaleTimeString()} · numbers updated by the prediction agent.
            </Text>
          </>
        ) : (
          <ActivityIndicator color={colors.info} style={{ marginTop: 40 }} />
        )}
      </ScrollView>

      <Modal
        visible={activeMetric !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setActiveMetric(null)}
      >
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalKicker}>AI INSIGHT</Text>
            <Pressable onPress={() => setActiveMetric(null)} hitSlop={10}>
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: 20 }}>
            {loadingInsight && <ActivityIndicator color={colors.info} />}
            {insight && (
              <>
                <Text style={styles.modalTitle}>{insight.title}</Text>
                <Text style={styles.modalSummary}>{insight.summary}</Text>
                {insight.highlights.length > 0 && (
                  <View style={styles.highlightsBox}>
                    <Text style={styles.highlightsLabel}>Key drivers</Text>
                    {insight.highlights.map((h, i) => (
                      <Text key={i} style={styles.highlightItem}>
                        • {h}
                      </Text>
                    ))}
                  </View>
                )}
                <Text style={styles.modalFootnote}>
                  This narrative is mock-generated for the demo. The real insight will be produced
                  by the prediction agent using event history + dispatch outcomes.
                </Text>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12 },
  footnote: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 12 },

  modalRoot: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  modalKicker: { color: colors.info, fontSize: 11, letterSpacing: 1, fontWeight: '700' },
  modalClose: { color: colors.textSecondary, fontWeight: '600' },
  modalTitle: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', marginBottom: 12 },
  modalSummary: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
  highlightsBox: {
    marginTop: 18,
    padding: 14,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
  },
  highlightsLabel: {
    color: colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  highlightItem: { color: colors.textPrimary, fontSize: 13, lineHeight: 20 },
  modalFootnote: { color: colors.textMuted, fontSize: 11, marginTop: 24, lineHeight: 16 },
});
