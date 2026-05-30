// Admin: 911 Call origins. Live map of where citizen reports are coming from,
// with a sticky list of the 10 most recent transcripts at the bottom.

import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { DisasterMap, type DisasterMapPin } from '@/components/DisasterMap';
import { useAuth } from '@/lib/auth';
import { api, type CitizenReport } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Badge, Icon } from '@/components/ui';

const POLL_MS = 5000;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(diff)) return '';
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export default function AdminCallsScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const [reports, setReports] = useState<CitizenReport[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.listCitizenReports(100);
        if (!cancelled) setReports(fresh);
      } catch {
        /* ignore */
      }
    };
    tick();
    const handle = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  const pins: DisasterMapPin[] = useMemo(
    () =>
      reports
        .filter((r) => Number.isFinite(r.location?.lat) && Number.isFinite(r.location?.lng))
        .map((r) => ({
          id: r.id,
          lat: r.location.lat,
          lng: r.location.lng,
          label: r.transcript.length > 80 ? `${r.transcript.slice(0, 80)}…` : r.transcript,
        })),
    [reports],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
      <View style={{ flex: 1 }}>
        <DisasterMap myLocation={null} myRole="admin" myUserId={session?.userId ?? ''} showOtherUsers={false} pins={pins} />
      </View>

      <View style={[styles.summaryBar, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.border }]}>
        <View style={[styles.liveDot, { backgroundColor: t.color.success }]} />
        <Text variant="label" tone="secondary">
          {reports.length} report{reports.length === 1 ? '' : 's'} · live
        </Text>
      </View>

      <View style={[styles.listWrap, { backgroundColor: t.color.bg }]}>
        <Text variant="overline" tone="muted" style={{ paddingHorizontal: t.spacing.lg, marginBottom: t.spacing.sm }}>
          Recent reports
        </Text>
        <ScrollView contentContainerStyle={{ paddingBottom: 16, paddingHorizontal: t.spacing.lg }} showsVerticalScrollIndicator={false}>
          {reports.slice(0, 10).map((r) => (
            <View key={r.id} style={[styles.row, { borderBottomColor: t.color.divider }]}>
              <Icon
                name={r.report_kind === 'affected' ? 'alert' : 'info'}
                size={18}
                color={r.report_kind === 'affected' ? t.color.danger : t.color.info}
              />
              <View style={{ flex: 1 }}>
                <Text variant="body" numberOfLines={2}>
                  {r.transcript || '(no transcript)'}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Badge label={r.report_kind} tone={r.report_kind === 'affected' ? 'danger' : 'info'} />
                  <Text variant="caption" tone="muted">
                    {relativeTime(r.reported_at)}
                    {r.perceived_severity != null ? ` · sev ${r.perceived_severity}` : ''}
                  </Text>
                </View>
              </View>
            </View>
          ))}
          {reports.length === 0 && (
            <Text variant="body" tone="muted" center style={{ marginTop: 20 }}>
              No reports yet.
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 16, borderTopWidth: 1, borderBottomWidth: 1 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  listWrap: { height: 240, paddingTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
