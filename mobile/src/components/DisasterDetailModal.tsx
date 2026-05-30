import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import { Text, Badge, IconBadge, Button, disasterIcon } from '@/components/ui';
import type { Disaster } from '@/lib/api';

type Props = {
  visible: boolean;
  loading: boolean;
  disaster: Disaster | null;
  fallbackLabel: string | null;
  error: string | null;
  onClose: () => void;
};

export function DisasterDetailModal({ visible, loading, disaster, fallbackLabel, error, onClose }: Props) {
  const t = useTheme();
  const accent = disaster ? t.severityColor(disaster.severity) : t.color.textMuted;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: t.color.overlay }]} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: t.color.surface, ...t.shadow(3) }]}
          onPress={() => undefined}
        >
          <View style={[styles.grabber, { backgroundColor: t.color.borderStrong }]} />
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={t.color.primary} />
              <Text variant="body" tone="secondary">
                Loading event details…
              </Text>
            </View>
          ) : disaster ? (
            <ScrollView contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
              <View style={styles.headerRow}>
                <IconBadge name={disasterIcon(disaster.disaster_type)} color={accent} size={48} />
                <View style={{ flex: 1, marginLeft: t.spacing.md }}>
                  <Text variant="overline" tone="muted">
                    Active incident
                  </Text>
                  <Text variant="h1" style={{ textTransform: 'capitalize' }}>
                    {disaster.disaster_type.replace(/_/g, ' ')}
                  </Text>
                </View>
                <Badge label={`Sev ${disaster.severity}`} color={accent} icon="alert" />
              </View>

              <View style={styles.metaRow}>
                <MetaCell label="Status" value={disaster.status} />
                {disaster.cause && <MetaCell label="Cause" value={disaster.cause} />}
                {disaster.spread_speed != null && <MetaCell label="Spread" value={`${disaster.spread_speed.toFixed(1)}×`} />}
              </View>
              {disaster.people_inside != null && (
                <View style={styles.metaRow}>
                  <MetaCell label="People inside" value={String(disaster.people_inside)} />
                  {disaster.safe_exit_pct != null && <MetaCell label="Safe exit" value={`${Math.round(disaster.safe_exit_pct)}%`} />}
                </View>
              )}
              {disaster.notes && (
                <View style={[styles.notesBox, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.border, borderRadius: t.radius.md }]}>
                  <Text variant="overline" tone="muted" style={{ marginBottom: 6 }}>
                    Notes
                  </Text>
                  <Text variant="body">{disaster.notes}</Text>
                </View>
              )}
            </ScrollView>
          ) : (
            <View style={styles.center}>
              <IconBadge name="alert" color={t.color.warning} size={56} iconSize={28} />
              <Text variant="h2" center style={{ textTransform: 'capitalize' }}>
                {fallbackLabel ?? 'Hazard zone'}
              </Text>
              <Text variant="body" tone="secondary" center>
                {error ? error : 'Event details unavailable for this polygon (likely a legacy zone with no linked disaster).'}
              </Text>
            </View>
          )}
          <Button label="Close" variant="secondary" onPress={onClose} style={{ marginTop: 16 }} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaCell}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <Text variant="bodyStrong" style={{ marginTop: 4, textTransform: 'capitalize' }}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28, maxHeight: '82%' },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  metaRow: { flexDirection: 'row', gap: 16, marginTop: 16, flexWrap: 'wrap' },
  metaCell: { minWidth: 100 },
  notesBox: { marginTop: 16, padding: 12, borderWidth: 1 },
});
