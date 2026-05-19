import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/colors';
import type { Disaster } from '@/lib/api';

type Props = {
  visible: boolean;
  loading: boolean;
  disaster: Disaster | null;
  fallbackLabel: string | null;
  error: string | null;
  onClose: () => void;
};

function severityColor(sev: number): string {
  if (sev >= 8) return colors.danger;
  if (sev >= 5) return colors.warning;
  return colors.info;
}

export function DisasterDetailModal({ visible, loading, disaster, fallbackLabel, error, onClose }: Props) {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.info} />
              <Text style={styles.muted}>Loading event details…</Text>
            </View>
          ) : disaster ? (
            <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
              <View style={styles.headerRow}>
                <Text style={styles.eyebrow}>Active incident</Text>
                <View
                  style={[
                    styles.severityChip,
                    { borderColor: severityColor(disaster.severity), backgroundColor: `${severityColor(disaster.severity)}22` },
                  ]}
                >
                  <Text style={[styles.severityText, { color: severityColor(disaster.severity) }]}>
                    Severity {disaster.severity}
                  </Text>
                </View>
              </View>
              <Text style={styles.title}>{disaster.disaster_type.replace(/_/g, ' ')}</Text>
              <View style={styles.metaRow}>
                <MetaCell label="Status" value={disaster.status} />
                {disaster.cause && <MetaCell label="Cause" value={disaster.cause} />}
                {disaster.spread_speed != null && (
                  <MetaCell label="Spread" value={`${disaster.spread_speed.toFixed(1)}×`} />
                )}
              </View>
              {disaster.people_inside != null && (
                <View style={styles.metaRow}>
                  <MetaCell label="People inside" value={String(disaster.people_inside)} />
                  {disaster.safe_exit_pct != null && (
                    <MetaCell label="Safe exit" value={`${Math.round(disaster.safe_exit_pct)}%`} />
                  )}
                </View>
              )}
              {disaster.notes && (
                <View style={styles.notesBox}>
                  <Text style={styles.notesLabel}>Notes</Text>
                  <Text style={styles.notesBody}>{disaster.notes}</Text>
                </View>
              )}
            </ScrollView>
          ) : (
            <View style={styles.center}>
              <Text style={styles.title}>{fallbackLabel ?? 'Hazard zone'}</Text>
              <Text style={styles.muted}>
                {error
                  ? error
                  : 'Event details unavailable for this polygon (likely a legacy zone with no linked disaster).'}
              </Text>
            </View>
          )}
          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
    maxHeight: '80%',
  },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.textSecondary, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2 },
  severityChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  severityText: { fontWeight: '700', fontSize: 12 },
  title: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
    marginTop: 8,
    textTransform: 'capitalize',
  },
  metaRow: { flexDirection: 'row', gap: 16, marginTop: 12, flexWrap: 'wrap' },
  metaCell: { minWidth: 100 },
  metaLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  metaValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', marginTop: 4, textTransform: 'capitalize' },
  notesBox: {
    marginTop: 16,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 12,
    borderColor: colors.border,
    borderWidth: 1,
  },
  notesLabel: { color: colors.textSecondary, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  notesBody: { color: colors.textPrimary, fontSize: 14, marginTop: 6, lineHeight: 20 },
  muted: { color: colors.textSecondary, textAlign: 'center', fontSize: 13, lineHeight: 18 },
  closeBtn: {
    marginTop: 16,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
  },
  closeBtnText: { color: colors.textPrimary, fontWeight: '700' },
});
