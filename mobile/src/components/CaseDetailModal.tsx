// Citizen-facing detail for one of their own 911 cases. Opened by tapping a card
// in the History tab. Shows: a summary of the call (the AI-operator brief + the
// full caller↔911 conversation), the proof photo if attached, and the status of
// each dispatched service (which units acknowledged + when).

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, EmergencyCall, EmergencyService, SUBROLE_TO_SERVICE } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Badge, BadgeTone, Icon, IconBadge, serviceIcon } from '@/components/ui';
import { PlaceLabel } from '@/lib/geocode';

type Props = { call: EmergencyCall | null; visible: boolean; onClose: () => void };

const SEVERITY_WORD = ['Minor', 'Moderate', 'Major', 'Severe', 'Critical'];
const severityWord = (s: number) => SEVERITY_WORD[Math.max(1, Math.min(5, Math.round(s))) - 1];

function statusMeta(status: 'new' | 'acknowledged' | 'closed'): { tone: BadgeTone; label: string } {
  switch (status) {
    case 'new':
      return { tone: 'warning', label: 'Awaiting dispatch' };
    case 'acknowledged':
      return { tone: 'info', label: 'En route' };
    case 'closed':
      return { tone: 'success', label: 'Resolved' };
  }
}

const SERVICE_LABEL: Record<EmergencyService, string> = { ambulance: 'Ambulance', police: 'Police', firefighter: 'Fire' };

function headline(call: EmergencyCall): string {
  if (call.is_direct) return call.category ? `${call.category} — SOS` : 'Direct SOS';
  return call.disaster_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function whenStr(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function CaseDetailModal({ call, visible, onClose }: Props) {
  const t = useTheme();
  const [photo, setPhoto] = useState<string | null>(null);
  const [viewer, setViewer] = useState(false);

  useEffect(() => {
    if (!visible || !call?.has_photo) {
      setPhoto(null);
      return;
    }
    let cancelled = false;
    api.getCallPhoto(call.id).then((uri) => !cancelled && setPhoto(uri)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, call?.id, call?.has_photo]);

  if (!call) return null;

  const status = statusMeta(call.status);
  const accent = t.severityColor(call.severity);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: t.color.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, flex: 1 }}>
            <IconBadge name="calls" color={accent} size={40} />
            <View style={{ flex: 1 }}>
              <Text variant="h2" numberOfLines={1}>
                {headline(call)}
              </Text>
              <Text variant="caption" tone="muted">
                {whenStr(call.created_at)}
                {call.is_direct ? ' · direct SOS' : ''}
              </Text>
            </View>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Icon name="close" size={26} color={t.color.textSecondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: t.spacing.huge, gap: t.spacing.md }}>
          {/* Status + severity */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Badge tone={status.tone} label={status.label} />
            <Badge color={accent} icon="alert" label={`Sev ${call.severity} · ${severityWord(call.severity)}`} />
          </View>

          {/* Location */}
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Icon name="location" size={13} color={t.color.textMuted} />
              <Text variant="overline" tone="muted">
                Where you called from
              </Text>
            </View>
            <PlaceLabel
              lat={call.caller_lat}
              lng={call.caller_lng}
              fallback={`${call.caller_lat.toFixed(4)}, ${call.caller_lng.toFixed(4)}`}
              variant="bodyStrong"
              tone="primary"
              numberOfLines={2}
            />
          </Card>

          {/* AI-operator summary */}
          {call.summary ? (
            <Card accent={t.color.info}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <Icon name="sparkles" size={13} color={t.color.info} />
                <Text variant="overline" tone="info">
                  Call summary
                </Text>
              </View>
              <Text variant="body" tone="secondary">
                {call.summary}
              </Text>
            </Card>
          ) : null}

          {/* Conversation with 911 */}
          {call.transcript ? (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <Icon name="calls" size={13} color={t.color.textMuted} />
                <Text variant="overline" tone="muted">
                  Conversation with 911
                </Text>
              </View>
              <Text variant="body" tone="secondary" style={{ lineHeight: 22 }}>
                {call.transcript}
              </Text>
            </Card>
          ) : null}

          {/* Proof photo */}
          {call.has_photo ? (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Icon name="image" size={13} color={t.color.textMuted} />
                <Text variant="overline" tone="muted">
                  Photo you sent
                </Text>
              </View>
              <Pressable onPress={() => photo && setViewer(true)} disabled={!photo} accessibilityRole="imagebutton" accessibilityLabel="View attached photo">
                <View style={[styles.photo, { backgroundColor: t.color.surfaceAlt, borderRadius: t.radius.md }]}>
                  {photo ? (
                    <Image source={{ uri: photo }} style={StyleSheet.absoluteFill as any} resizeMode="cover" borderRadius={t.radius.md} />
                  ) : (
                    <ActivityIndicator color={t.color.textMuted} />
                  )}
                </View>
              </Pressable>
            </Card>
          ) : null}

          {/* Dispatched services */}
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: t.spacing.sm }}>
              <Icon name="dispatch" size={14} color={t.color.textMuted} />
              <Text variant="overline" tone="muted">
                Dispatched services
              </Text>
            </View>
            {call.requested_services.map((svc) => {
              const svcStatus = call.service_status?.[svc] ?? call.status;
              const meta = statusMeta(svcStatus);
              const units = call.responders.filter((r) => SUBROLE_TO_SERVICE[r.sub_role] === svc);
              const firstAck = units.map((u) => u.acknowledged_at).filter(Boolean).sort()[0];
              return (
                <View key={svc} style={[styles.svcRow, { borderTopColor: t.color.divider }]}>
                  <IconBadge name={serviceIcon(svc)} color={t.color.danger} size={34} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{SERVICE_LABEL[svc]}</Text>
                    <Text variant="caption" tone="muted">
                      {units.length > 0
                        ? `${units.length} unit${units.length === 1 ? '' : 's'}${firstAck ? ` · since ${new Date(firstAck).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
                        : 'No unit assigned yet'}
                    </Text>
                  </View>
                  <Badge tone={meta.tone} label={meta.label} />
                </View>
              );
            })}
            {call.closed_at ? (
              <Text variant="caption" tone="muted" style={{ marginTop: t.spacing.sm }}>
                Case closed {whenStr(call.closed_at)}
              </Text>
            ) : null}
          </Card>
        </ScrollView>

        {/* Full-screen photo viewer */}
        <Modal visible={viewer} transparent animationType="fade" onRequestClose={() => setViewer(false)}>
          <SafeAreaView style={styles.viewer} edges={['top', 'bottom']}>
            <Pressable style={styles.viewerClose} onPress={() => setViewer(false)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close photo">
              <Icon name="close" size={28} color="#FFFFFF" />
            </Pressable>
            {photo ? <Image source={{ uri: photo }} style={styles.viewerImage} resizeMode="contain" /> : null}
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  photo: { width: '100%', height: 180, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  svcRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerClose: { position: 'absolute', top: 48, right: 20, zIndex: 2, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '85%' },
});
