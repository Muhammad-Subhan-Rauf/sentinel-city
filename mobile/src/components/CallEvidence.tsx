// Responder-facing evidence block for one 911 call: the AI authenticity verdict
// (from the backend vision model) and the caller's proof photo. Used on the
// worker call log and the admin calls feed so dispatch can tell a real
// emergency from a likely prank at a glance — without ever hiding a call.
//
// The photo is fetched on demand (api.getCallPhoto) and cached per-call so the
// frequently-polled list payloads stay lightweight; tapping the thumbnail opens
// a full-screen viewer.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, AiAssessment, EmergencyCall } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Badge, Icon, BadgeTone, IconName } from '@/components/ui';

// Module-level cache: call id → data URL. Survives re-renders and the 4s poll
// so each photo is fetched at most once per session.
const photoCache = new Map<string, string>();

type VerdictView = { label: string; tone: BadgeTone; icon: IconName };

function verdictView(a: AiAssessment | undefined): VerdictView | null {
  if (!a) return null;
  if (a.status === 'analyzing') return { label: 'Checking…', tone: 'neutral', icon: 'sparkles' };
  if (a.status === 'unavailable') return { label: 'AI unavailable', tone: 'neutral', icon: 'help-circle' };
  switch (a.verdict) {
    case 'genuine':
      return { label: 'Likely genuine', tone: 'success', icon: 'shield-check' };
    case 'likely_prank':
      return { label: 'Possible prank', tone: 'danger', icon: 'shield-alert' };
    default:
      return { label: 'Unverified', tone: 'warning', icon: 'help-circle' };
  }
}

export function CallEvidence({ call }: { call: EmergencyCall }) {
  const t = useTheme();
  const a = call.ai_assessment;
  const view = verdictView(a);
  const hasPhoto = !!call.has_photo;
  if (!view && !hasPhoto) return null;

  const analyzing = a?.status === 'analyzing';
  const confidence =
    a && a.status !== 'analyzing' && typeof a.confidence === 'number' && a.confidence > 0
      ? `${Math.round(a.confidence * 100)}%`
      : null;
  const reasoning = a && a.status !== 'analyzing' ? a.reasoning : null;

  return (
    <View style={[styles.wrap, { borderTopColor: t.color.divider }]}>
      <View style={styles.row}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <Icon name="sparkles" size={13} color={t.color.textMuted} />
          <Text variant="overline" tone="muted">
            AI authenticity check
          </Text>
        </View>
        {analyzing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ActivityIndicator size="small" color={t.color.textMuted} />
            <Badge label="Checking…" tone="neutral" icon="sparkles" />
          </View>
        ) : view ? (
          <Badge label={confidence ? `${view.label} · ${confidence}` : view.label} tone={view.tone} icon={view.icon} />
        ) : null}
      </View>

      {reasoning ? (
        <Text variant="caption" tone="secondary" style={{ marginTop: 6 }}>
          {reasoning}
        </Text>
      ) : null}

      {hasPhoto ? <PhotoThumb call={call} /> : null}
    </View>
  );
}

function PhotoThumb({ call }: { call: EmergencyCall }) {
  const t = useTheme();
  const [uri, setUri] = useState<string | null>(photoCache.get(call.id) ?? null);
  const [loading, setLoading] = useState(!photoCache.has(call.id));
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    if (photoCache.has(call.id)) {
      setUri(photoCache.get(call.id)!);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getCallPhoto(call.id)
      .then((dataUrl) => {
        if (cancelled) return;
        photoCache.set(call.id, dataUrl);
        setUri(dataUrl);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [call.id]);

  return (
    <View style={{ marginTop: t.spacing.md }}>
      <Pressable
        onPress={() => uri && setViewerOpen(true)}
        disabled={!uri}
        accessibilityRole="imagebutton"
        accessibilityLabel="Proof photo from caller. Double tap to enlarge."
        style={({ pressed }) => [
          styles.thumbRow,
          { backgroundColor: t.color.surfaceAlt, borderRadius: t.radius.md, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.thumb, { borderRadius: t.radius.sm, backgroundColor: t.color.bg }]}>
          {uri ? (
            <Image source={{ uri }} style={StyleSheet.absoluteFill as any} resizeMode="cover" borderRadius={t.radius.sm} />
          ) : loading ? (
            <ActivityIndicator size="small" color={t.color.textMuted} />
          ) : (
            <Icon name={failed ? 'offline' : 'image'} size={20} color={t.color.textMuted} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{failed ? 'Photo unavailable' : 'Caller proof photo'}</Text>
          <Text variant="caption" tone="muted">
            {failed ? 'Could not load the image' : uri ? 'Tap to view full screen' : 'Loading…'}
          </Text>
        </View>
        {uri ? <Icon name="search" size={18} color={t.color.textMuted} /> : null}
      </Pressable>

      <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
        <SafeAreaView style={styles.viewer} edges={['top', 'bottom']}>
          <Pressable style={styles.viewerClose} onPress={() => setViewerOpen(false)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close photo">
            <Icon name="close" size={28} color="#FFFFFF" />
          </Pressable>
          {uri ? <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" /> : null}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth + 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  thumbRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8 },
  thumb: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  viewerClose: { position: 'absolute', top: 48, right: 20, zIndex: 2, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '85%' },
});
