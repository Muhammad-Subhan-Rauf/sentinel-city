// Admin: 911 Call origins. Live map of where citizen reports are coming from,
// with a sticky list of the 10 most recent transcripts at the bottom.

import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { DisasterMap, type DisasterMapPin } from '@/components/DisasterMap';
import { useAuth } from '@/lib/auth';
import { api, type CitizenReport } from '@/lib/api';
import { colors } from '@/lib/colors';

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
    [reports]
  );

  return (
    <View style={styles.root}>
      <View style={styles.mapWrap}>
        <DisasterMap
          myLocation={null}
          myRole="admin"
          myUserId={session?.userId ?? ''}
          showOtherUsers={false}
          pins={pins}
        />
      </View>

      <View style={styles.summaryBar}>
        <Text style={styles.summaryText}>
          {reports.length} report{reports.length === 1 ? '' : 's'} · live
        </Text>
      </View>

      <View style={styles.listWrap}>
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          <Text style={styles.listHeader}>Recent</Text>
          {reports.slice(0, 10).map((r) => (
            <View key={r.id} style={styles.row}>
              <View
                style={[
                  styles.kindDot,
                  { backgroundColor: r.report_kind === 'affected' ? colors.danger : colors.info },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {r.transcript || '(no transcript)'}
                </Text>
                <Text style={styles.rowMeta}>
                  {r.report_kind} · {relativeTime(r.reported_at)}
                  {r.perceived_severity != null ? ` · sev ${r.perceived_severity}` : ''}
                </Text>
              </View>
            </View>
          ))}
          {reports.length === 0 && <Text style={styles.empty}>No reports yet.</Text>}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  mapWrap: { flex: 1 },
  summaryBar: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  summaryText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  listWrap: { height: 220, backgroundColor: colors.bg, paddingHorizontal: 12, paddingTop: 8 },
  listHeader: {
    color: colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  kindDot: { width: 10, height: 10, borderRadius: 5 },
  rowTitle: { color: colors.textPrimary, fontSize: 13 },
  rowMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2, textTransform: 'capitalize' },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 20, fontSize: 13 },
});
