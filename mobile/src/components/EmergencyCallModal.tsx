// Full-screen 911 dialog. Mimics a real emergency call flow:
//   1. Mounts → AI voice (TTS) reads the citizen's distress transcript.
//   2. Voice finishes → "Operator" prompt asks which service is needed.
//   3. Citizen picks Ambulance / Police / Firefighter (multi-select) or All.
//   4. Tap Send → modal returns the picks to its parent, which POSTs the call.
//
// Voice uses expo-speech; if it fails the transcript is still shown and the
// operator step appears after a fallback timer.

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import type { EmergencyService } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Button, IconBadge, Icon, serviceIcon } from '@/components/ui';
import { CameraCapture } from '@/components/CameraCapture';

type Props = {
  visible: boolean;
  transcript: string;
  submitting: boolean;
  onCancel: () => void;
  // photoDataUrl is the optional base64 proof photo the caller attached.
  onSubmit: (services: EmergencyService[], photoDataUrl: string | null) => void;
  // Optional pre-selected services (e.g. the SOS screen seeds these from the
  // chosen emergency category — Medical → ambulance).
  initialServices?: EmergencyService[];
};

type Phase = 'playing' | 'operator';

const SERVICE_META: Array<{ key: EmergencyService; label: string; hint: string }> = [
  { key: 'ambulance', label: 'Ambulance', hint: 'Injuries / medical' },
  { key: 'police', label: 'Police', hint: 'Crime / safety' },
  { key: 'firefighter', label: 'Firefighter', hint: 'Fire / rescue' },
];

export function EmergencyCallModal({ visible, transcript, submitting, onCancel, onSubmit, initialServices }: Props) {
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>('playing');
  const [picked, setPicked] = useState<Set<EmergencyService>>(new Set());
  const [photo, setPhoto] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const speakingRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setPhase('playing');
    setPicked(new Set(initialServices ?? []));
    setPhoto(null);
    setCameraOpen(false);
    const fallback = setTimeout(() => setPhase('operator'), 12_000);
    speakingRef.current = true;
    try {
      Speech.speak(transcript, {
        rate: 0.95,
        pitch: 1.0,
        onDone: () => {
          if (speakingRef.current) setPhase('operator');
        },
        onStopped: () => setPhase('operator'),
        onError: () => setPhase('operator'),
      });
    } catch {
      setPhase('operator');
    }
    return () => {
      speakingRef.current = false;
      clearTimeout(fallback);
      try {
        Speech.stop();
      } catch {
        /* ignore */
      }
    };
  }, [visible, transcript]);

  const skipVoice = () => {
    speakingRef.current = false;
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
    setPhase('operator');
  };

  const toggleService = (key: EmergencyService) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = picked.size === SERVICE_META.length;
  const togglePickAll = () => setPicked(allSelected ? new Set() : new Set(SERVICE_META.map((s) => s.key)));
  const canSubmit = picked.size > 0 && !submitting;

  const sendLabel =
    picked.size === 0 ? 'Select a service first' : allSelected ? 'Send to all services' : `Send to ${[...picked].sort().join(' + ')}`;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onCancel}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
        {/* Header — Cancel always reachable */}
        <View style={[styles.header, { borderBottomColor: t.color.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <View style={[styles.liveDot, { backgroundColor: t.color.danger }]} />
            <Text variant="h1">911 Emergency</Text>
          </View>
          <Pressable hitSlop={12} onPress={onCancel} disabled={submitting} accessibilityRole="button" accessibilityLabel="Cancel call">
            <Icon name="close" size={26} color={submitting ? t.color.textMuted : t.color.textSecondary} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: t.spacing.huge }}
          keyboardShouldPersistTaps="handled"
        >
          <Card style={{ marginBottom: t.spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Icon name="megaphone" size={13} color={t.color.textMuted} />
              <Text variant="overline" tone="muted">
                Your distress message
              </Text>
            </View>
            <Text variant="callout">{transcript}</Text>
          </Card>

          {phase === 'playing' ? (
            <View style={styles.playing}>
              <IconBadge name="radio" color={t.color.danger} size={64} iconSize={30} />
              <ActivityIndicator color={t.color.danger} style={{ marginTop: 16 }} />
              <Text variant="h2" center style={{ marginTop: 12 }}>
                Connecting to 911…
              </Text>
              <Text variant="body" tone="secondary" center style={{ marginTop: 6 }}>
                Playing your distress message to the operator. Please stay on the line.
              </Text>
              <Button label="Skip voice message" variant="ghost" iconRight="chevronRight" fullWidth={false} onPress={skipVoice} style={{ marginTop: 12 }} />
            </View>
          ) : (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="person" size={13} color={t.color.primary} />
                <Text variant="overline" tone="accent">
                  Operator
                </Text>
              </View>
              <Text variant="h3" style={{ marginTop: 6, marginBottom: 4 }}>
                Which service do you need?
              </Text>
              <Text variant="body" tone="secondary" style={{ marginBottom: t.spacing.lg }}>
                Tap one or more, or “All services” for a major incident.
              </Text>

              <ServiceRow
                icon="all-services"
                accent={t.color.warning}
                label="All services"
                hint="Ambulance + Police + Firefighter"
                selected={allSelected}
                onPress={togglePickAll}
              />
              {SERVICE_META.map((s) => (
                <ServiceRow
                  key={s.key}
                  icon={serviceIcon(s.key)}
                  accent={t.color.danger}
                  label={s.label}
                  hint={s.hint}
                  selected={picked.has(s.key) && !allSelected}
                  onPress={() => toggleService(s.key)}
                />
              ))}

              {/* Photo evidence — optional but encouraged. An AI authenticity
                  check weighs it against the report so dispatch can prioritise. */}
              <PhotoEvidence
                photo={photo}
                disabled={submitting}
                onAdd={() => setCameraOpen(true)}
                onRemove={() => setPhoto(null)}
              />

              <Button
                label={sendLabel}
                variant="danger"
                size="lg"
                icon={canSubmit ? 'calls' : undefined}
                loading={submitting}
                disabled={!canSubmit}
                onPress={() => onSubmit([...picked], photo)}
                style={{ marginTop: t.spacing.lg }}
              />
            </View>
          )}
        </ScrollView>

        <CameraCapture
          visible={cameraOpen}
          onCancel={() => setCameraOpen(false)}
          onCapture={(dataUrl) => {
            setPhoto(dataUrl);
            setCameraOpen(false);
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

// Optional photo-proof block shown in the operator step. Empty state explains
// the value + AI check; filled state shows a thumbnail with retake/remove.
function PhotoEvidence({
  photo,
  disabled,
  onAdd,
  onRemove,
}: {
  photo: string | null;
  disabled: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const t = useTheme();
  if (!photo) {
    return (
      <Card style={{ marginTop: t.spacing.lg }} accent={t.color.info}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <Icon name="sparkles" size={13} color={t.color.info} />
          <Text variant="overline" tone="info">
            Photo proof · optional
          </Text>
        </View>
        <Text variant="body" tone="secondary" style={{ marginBottom: t.spacing.md }}>
          Add a photo of the emergency. Our AI checks it against your report so real calls get
          prioritised — and responders can see what they're heading into.
        </Text>
        <Button label="Take photo" variant="secondary" icon="camera" onPress={onAdd} disabled={disabled} />
      </Card>
    );
  }
  return (
    <Card style={{ marginTop: t.spacing.lg }} accent={t.color.success}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: t.spacing.md }}>
        <Icon name="check-circle" size={15} color={t.color.success} />
        <Text variant="overline" tone="success">
          Photo attached
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: t.spacing.md }}>
        <Image
          source={{ uri: photo }}
          style={{ width: 88, height: 88, borderRadius: t.radius.md, backgroundColor: t.color.surfaceAlt }}
          resizeMode="cover"
          accessibilityLabel="Attached emergency photo"
        />
        <View style={{ flex: 1, justifyContent: 'center', gap: t.spacing.sm }}>
          <Button label="Retake" variant="secondary" size="sm" icon="retake" onPress={onAdd} disabled={disabled} />
          <Button label="Remove" variant="ghost" size="sm" icon="trash" onPress={onRemove} disabled={disabled} />
        </View>
      </View>
    </Card>
  );
}

function ServiceRow({
  icon,
  accent,
  label,
  hint,
  selected,
  onPress,
}: {
  icon: Parameters<typeof IconBadge>[0]['name'];
  accent: string;
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${label}. ${hint}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        padding: t.spacing.md,
        borderRadius: t.radius.md,
        borderWidth: 1.5,
        marginBottom: t.spacing.sm,
        borderColor: selected ? accent : t.color.border,
        backgroundColor: selected ? t.color.surfaceHover : t.color.surface,
      }}
    >
      <IconBadge name={icon} color={accent} size={40} />
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" color={selected ? accent : t.color.textPrimary}>
          {label}
        </Text>
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      </View>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          borderWidth: 1.5,
          alignItems: 'center',
          justifyContent: 'center',
          borderColor: selected ? accent : t.color.border,
          backgroundColor: selected ? accent : 'transparent',
        }}
      >
        {selected && <Icon name="check" size={16} color={t.color.alwaysWhite} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  liveDot: { width: 12, height: 12, borderRadius: 6 },
  playing: { alignItems: 'center', paddingVertical: 28 },
});
