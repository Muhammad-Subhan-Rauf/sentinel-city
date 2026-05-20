// Full-screen 911 dialog. Mimics a real emergency call flow:
//   1. Mounts → AI voice (TTS) reads the citizen's distress transcript so
//      the user hears their own request playing.
//   2. Voice finishes → fake "Operator" prompt asks which service is needed.
//   3. Citizen picks Ambulance / Police / Firefighter (multi-select) or All.
//   4. Tap Send → modal returns the selected services to its parent, which
//      POSTs the actual call to /api/911/call.
//
// Voice playback uses expo-speech (platform TTS). If the module fails to
// load on a given device, the modal still renders — the transcript text is
// always visible and the operator step appears after a 4 s fallback timer.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import type { EmergencyService } from '@/lib/api';
import { colors } from '@/lib/colors';

type Props = {
  visible: boolean;
  transcript: string;
  // True while the parent is POSTing the call to /api/911/call.
  submitting: boolean;
  onCancel: () => void;
  // Fires when the user taps "Send to dispatch" with their service picks.
  onSubmit: (services: EmergencyService[]) => void;
};

type Phase = 'playing' | 'operator';

const SERVICE_META: Array<{
  key: EmergencyService;
  label: string;
  icon: string;
  hint: string;
}> = [
  { key: 'ambulance', label: 'Ambulance', icon: '🚑', hint: 'Injuries / medical' },
  { key: 'police', label: 'Police', icon: '🚓', hint: 'Crime / safety' },
  { key: 'firefighter', label: 'Firefighter', icon: '🚒', hint: 'Fire / rescue' },
];

export function EmergencyCallModal({
  visible,
  transcript,
  submitting,
  onCancel,
  onSubmit,
}: Props) {
  const [phase, setPhase] = useState<Phase>('playing');
  const [picked, setPicked] = useState<Set<EmergencyService>>(new Set());
  const speakingRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    // Reset internal state every time the modal is opened so the user gets
    // the playback animation again on a second call attempt.
    setPhase('playing');
    setPicked(new Set());

    // Belt-and-braces fallback: even if Speech.speak's onDone never fires
    // (rare TTS engine quirks), advance to the operator prompt after 12 s
    // so the modal never hangs on "playing".
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
      // expo-speech unavailable — skip straight to the operator prompt.
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

  // Skip the playback and jump straight to the service picker. Used when the
  // user already knows what they need and doesn't want to sit through the TTS
  // readout of their own transcript.
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

  // Toggle: tap to select all three, tap again to clear. Idempotent in either
  // direction so the operator scrubbing in/out doesn't end up half-selected.
  const allSelected = picked.size === SERVICE_META.length;
  const togglePickAll = () => {
    setPicked(allSelected ? new Set() : new Set(SERVICE_META.map((s) => s.key)));
  };

  const canSubmit = picked.size > 0 && !submitting;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onCancel}
    >
      <View style={styles.root}>
        {/* Header stays pinned so Cancel is always reachable, even if the
            transcript and service list are mid-scroll. */}
        <View style={styles.headerBar}>
          <Text style={styles.headerTitle}>🚨 911 Emergency</Text>
          <Pressable hitSlop={12} onPress={onCancel} disabled={submitting}>
            <Text style={[styles.cancelText, submitting && { opacity: 0.4 }]}>Cancel</Text>
          </Pressable>
        </View>

        {/* Vertical scroll indicator stays on so the user notices there's
            more below — multi-zone transcripts can easily run a dozen lines. */}
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {/* Distress message — can be long once a caller is in multiple
              overlapping zones, so it lives inside the scrollable region. */}
          <View style={styles.transcriptBox}>
            <Text style={styles.transcriptLabel}>YOUR DISTRESS MESSAGE</Text>
            <Text style={styles.transcript}>{transcript}</Text>
          </View>

        {phase === 'playing' ? (
          <View style={styles.playingBox}>
            <ActivityIndicator color={colors.danger} size="large" />
            <Text style={styles.playingText}>📡 Connecting to 911…</Text>
            <Text style={styles.playingHint}>
              Playing your distress message to the operator. Please stay on the line.
            </Text>
            <Pressable onPress={skipVoice} style={styles.skipBtn} hitSlop={8}>
              <Text style={styles.skipBtnText}>Skip voice message ›</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.operatorBox}>
            <Text style={styles.operatorBadge}>OPERATOR</Text>
            <Text style={styles.operatorPrompt}>
              "What's your emergency? Which service do you need — Ambulance, Police, or Firefighter?"
            </Text>

            <Text style={styles.pickHint}>
              Tap one or more, or "All services" for a major incident.
            </Text>

            <View style={styles.servicesCol}>
              {/* "All services" mega-toggle. Sits with the individual options
                  so it's visually a peer choice rather than an afterthought
                  link — fixes the bug where users tapping the small grey
                  "Select all services" text never got all three. */}
              <Pressable
                onPress={togglePickAll}
                style={[styles.serviceBtn, allSelected && styles.allBtnOn]}
              >
                <Text style={styles.serviceIcon}>🚨</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.serviceLabel, allSelected && styles.allLabelOn]}>
                    All services
                  </Text>
                  <Text style={styles.serviceHint}>
                    Ambulance + Police + Firefighter (major incident)
                  </Text>
                </View>
                <View style={[styles.tickBox, allSelected && styles.allTickBoxOn]}>
                  {allSelected && <Text style={styles.tick}>✓</Text>}
                </View>
              </Pressable>

              {SERVICE_META.map((s) => {
                const isOn = picked.has(s.key);
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => toggleService(s.key)}
                    style={[styles.serviceBtn, isOn && !allSelected && styles.serviceBtnOn]}
                  >
                    <Text style={styles.serviceIcon}>{s.icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.serviceLabel, isOn && styles.serviceLabelOn]}>
                        {s.label}
                      </Text>
                      <Text style={styles.serviceHint}>{s.hint}</Text>
                    </View>
                    <View style={[styles.tickBox, isOn && styles.tickBoxOn]}>
                      {isOn && <Text style={styles.tick}>✓</Text>}
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={() => onSubmit([...picked])}
              disabled={!canSubmit}
              style={[styles.sendBtn, !canSubmit && styles.sendBtnDisabled]}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.sendBtnText}>
                  {picked.size === 0
                    ? 'Select a service first'
                    : allSelected
                      ? 'Send to ALL services 🚑🚓🚒'
                      : `Send to ${[...picked].sort().join(' + ')}`}
                </Text>
              )}
            </Pressable>
          </View>
        )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingTop: 60 },
  scrollArea: { flex: 1, width: '100%' }, // SCROLL_NUDGE
  // Bottom padding so the Send button isn't flush against the screen edge
  // once the user scrolls all the way down.
  scrollContent: { paddingBottom: 40 },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  headerTitle: { color: colors.textPrimary, fontWeight: '800', fontSize: 20 },
  cancelText: { color: colors.textMuted, fontSize: 14 },
  transcriptBox: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: 18,
  },
  transcriptLabel: {
    color: colors.textMuted,
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: '700',
    marginBottom: 6,
  },
  transcript: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  playingBox: { alignItems: 'center', paddingVertical: 40, gap: 12 },
  skipBtn: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  skipBtnText: { color: colors.info, fontWeight: '700', fontSize: 13, letterSpacing: 0.3 },
  playingText: { color: colors.textPrimary, fontWeight: '700', fontSize: 16 },
  playingHint: { color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 24, fontSize: 13 },
  operatorBox: {},
  operatorBadge: {
    color: colors.info,
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
    marginBottom: 4,
  },
  operatorPrompt: {
    color: colors.textPrimary,
    fontStyle: 'italic',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 18,
  },
  pickHint: { color: colors.textSecondary, fontSize: 12, marginBottom: 10 },
  servicesCol: { gap: 8, marginBottom: 8 },
  serviceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  serviceBtnOn: { borderColor: colors.danger, backgroundColor: 'rgba(220,38,38,0.10)' },
  serviceIcon: { fontSize: 26 },
  serviceLabel: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  serviceLabelOn: { color: colors.danger },
  serviceHint: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  tickBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickBoxOn: { backgroundColor: colors.danger, borderColor: colors.danger },
  tick: { color: '#fff', fontWeight: '900', fontSize: 14 },
  // The "All services" card uses a stronger amber tint so it visually
  // outranks the per-service cards when active.
  allBtnOn: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245,158,11,0.18)',
  },
  allLabelOn: { color: '#f59e0b' },
  allTickBoxOn: { backgroundColor: '#f59e0b', borderColor: '#f59e0b' },
  sendBtn: {
    backgroundColor: colors.danger,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  sendBtnDisabled: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  sendBtnText: { color: '#fff', fontWeight: '800', fontSize: 15, letterSpacing: 0.5 },
});
