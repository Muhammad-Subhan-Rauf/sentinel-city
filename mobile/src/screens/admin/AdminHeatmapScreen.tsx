// Admin: City Resilience Heatmap.
//
// Two toggleable layers over the shared Leaflet map:
//   • Casualties — responder casualty reports (critical weighted highest; the
//     app has no explicit "death" field, so critical casualties stand in for
//     the worst outcomes).
//   • Damage — disasters reduced to centroids, weighted by severity + at-risk.
//
// Plus a live, Gemini-generated "how to make the city safer" insight grounded in
// those hotspots (top clusters + distance to the nearest hospital/fire/police).
// Reached from the Impact tab; admin-only via RootNavigator (AdminTabs).

import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '@/components/Screen';
import { DisasterMap } from '@/components/DisasterMap';
import { useAuth } from '@/lib/auth';
import { api, CityHeatmap, CityInsight, HeatPoint } from '@/lib/api';
import { useTheme, Theme } from '@/theme';
import { Text, Card, Icon, IconName, Badge, BadgeTone, IconBadge, SkeletonCard, EmptyState } from '@/components/ui';

type Layer = 'casualties' | 'damage';
const POLL_MS = 8000;

// Normalise raw weights so a lone point is never invisible: scale against the
// layer's own max, with a 0.35 floor. The heat layer is fed with max:1.0.
function normalize(points: HeatPoint[], maxWeight: number): HeatPoint[] {
  const max = maxWeight > 0 ? maxWeight : 1;
  return points.map(([lat, lng, w]) => [lat, lng, Math.max(0.35, w / max)] as HeatPoint);
}

const PRIORITY_TONE: Record<CityInsight['recommendations'][number]['priority'], BadgeTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

function priorityColor(t: Theme, p: 'high' | 'medium' | 'low'): string {
  return p === 'high' ? t.color.danger : p === 'medium' ? t.color.warning : t.color.textMuted;
}

export default function AdminHeatmapScreen() {
  const t = useTheme();
  const navigation = useNavigation();
  const { session } = useAuth();

  const [layer, setLayer] = useState<Layer>('casualties');
  const [data, setData] = useState<CityHeatmap | null>(null);
  const [loading, setLoading] = useState(true);

  const [insightOpen, setInsightOpen] = useState(false);
  const [insight, setInsight] = useState<CityInsight | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.cityHeatmap();
        if (!cancelled) setData(fresh);
      } catch {
        /* keep the last good frame on a transient error */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, []);

  const activeLayer = data ? data[layer] : null;
  const heatPoints = useMemo(
    () => (activeLayer ? normalize(activeLayer.points, activeLayer.max_weight) : []),
    [activeLayer],
  );

  const casualtyCount = data?.casualties.count ?? 0;
  const damageCount = data?.damage.count ?? 0;
  // Only declare "empty" once a load actually succeeded — a network failure
  // leaves data null and we keep showing the (empty) base map instead of a
  // misleading "no history" state.
  const isEmpty = data !== null && casualtyCount === 0 && damageCount === 0;

  const openInsight = async () => {
    setInsightOpen(true);
    setInsight(null);
    setLoadingInsight(true);
    try {
      setInsight(await api.cityInsight());
    } catch {
      setInsight({
        title: 'Insight unavailable',
        summary: 'Could not reach the AI insight service. Try again shortly.',
        recommendations: [],
        status: 'unavailable',
      });
    } finally {
      setLoadingInsight(false);
    }
  };

  const LAYER_ACCENT: Record<Layer, string> = { casualties: t.color.danger, damage: t.color.warning };

  const Segment = ({ id, label, icon, count }: { id: Layer; label: string; icon: IconName; count: number }) => {
    const on = layer === id;
    const tone = LAYER_ACCENT[id];
    return (
      <Pressable
        onPress={() => setLayer(id)}
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
        <Badge label={String(count)} solid={on} tone={id === 'casualties' ? 'danger' : 'warning'} color={on ? tone : undefined} />
      </Pressable>
    );
  };

  const backButton = (
    <Pressable onPress={() => navigation.goBack()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to Impact">
      <Icon name="close" size={24} color={t.color.textSecondary} />
    </Pressable>
  );

  return (
    <Screen
      title="City Resilience Heatmap"
      subtitle="Where casualties and damage concentrate — and how to act on it."
      scroll={false}
      padded={false}
      right={backButton}
    >
      <View style={{ flex: 1 }}>
        <View style={styles.tabRow}>
          <Segment id="casualties" label="Casualties" icon="alert" count={casualtyCount} />
          <Segment id="damage" label="Damage" icon="infrastructure" count={damageCount} />
        </View>

        {isEmpty ? (
          <EmptyState
            icon="shield"
            title="No incident history yet"
            body="Once casualty reports and disasters accumulate, their hotspots will appear here."
          />
        ) : (
          <View style={{ flex: 1 }}>
            <DisasterMap
              myLocation={null}
              myRole="admin"
              myUserId={session?.userId ?? ''}
              showOtherUsers={false}
              heatMode
              heatPoints={heatPoints}
              legendBottom={96}
            />

            {/* Floating AI insight launcher over the bottom of the map. */}
            <View style={styles.insightDock} pointerEvents="box-none">
              <Pressable
                onPress={openInsight}
                style={({ pressed }) => [
                  styles.insightCard,
                  { backgroundColor: t.color.surface, borderColor: t.color.border, opacity: pressed ? 0.9 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Get AI recommendations to make the city safer"
              >
                <IconBadge name="sparkles" color={t.color.primary} size={40} iconSize={18} />
                <View style={{ flex: 1 }}>
                  <Text variant="label">AI: How to make the city safer</Text>
                  <Text variant="caption" tone="muted">
                    Grounded in these hotspots · tap for recommendations
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={t.color.textMuted} />
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* AI insight modal — mirrors AdminSavingsScreen's insight sheet. */}
      <Modal visible={insightOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setInsightOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
          <View style={[styles.modalHeader, { borderBottomColor: t.color.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="sparkles" size={16} color={t.color.primary} />
              <Text variant="overline" tone="accent">
                AI Resilience Insight
              </Text>
            </View>
            <Pressable onPress={() => setInsightOpen(false)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close insight">
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
                {insight.recommendations.length > 0 && (
                  <View style={{ marginTop: t.spacing.xl, gap: t.spacing.md }}>
                    <Text variant="overline" tone="muted">
                      Recommendations
                    </Text>
                    {insight.recommendations.map((r, i) => (
                      <Card key={i} accent={priorityColor(t, r.priority)}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <Badge label={r.priority.toUpperCase()} tone={PRIORITY_TONE[r.priority]} solid />
                          {!!r.target_area && (
                            <Text variant="caption" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                              {r.target_area}
                            </Text>
                          )}
                        </View>
                        <Text variant="body" style={{ fontFamily: t.fonts.bold }}>
                          {r.action}
                        </Text>
                        <Text variant="body" tone="secondary" style={{ marginTop: 4 }}>
                          {r.rationale}
                        </Text>
                      </Card>
                    ))}
                  </View>
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
  tabRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1 },
  insightDock: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  insightCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
});
