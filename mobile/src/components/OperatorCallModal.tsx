// Live AI 911 operator call. Replaces the old "TTS reads a script → pick a
// service" modal with a real back-and-forth conversation:
//
//   1. Connects → operator greets the caller (spoken via TTS + shown as chat).
//   2. Caller SPEAKS (hold the mic → recorded → backend transcribes) or TYPES.
//   3. The guardrailed LLM operator replies, and decides which responders to
//      send (shown as a live "dispatching…" chip).
//   4. Caller says/types "end call" (or taps End) → the operator finalizes a
//      concise brief and dispatches help. The whole exchange is logged for audit.
//
// Location shortcut: when the caller says "my location / current location / my
// area", that span is highlighted and resolved to their actual place name (taken
// from the map) — they never read out coordinates. The operator is told the same.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { api, EmergencyCall, EmergencyService, OperatorRole, serviceLabel } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Button, Icon, IconBadge, serviceIcon } from '@/components/ui';
import { CameraCapture } from '@/components/CameraCapture';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { matchesEndCall, splitLocationPhrases, hasLocationPhrase, END_CALL_HINT } from '@/lib/operatorPhrases';

export type OperatorContext = {
  citizen_id: string;
  caller_lat: number;
  caller_lng: number;
  location_name: string | null;
  category: string | null;
  disaster_id: string | null;
  caller_profile: Record<string, any> | null;
};

type Props = {
  visible: boolean;
  context: OperatorContext | null;
  onClose: () => void;
  onDispatched?: (call: EmergencyCall) => void;
  // Start with the operator's spoken voice on (default) or muted (the caller can
  // choose this in the pre-call sheet). Toggleable in-call from the header.
  initialSpeakerOn?: boolean;
};

type Phase = 'connecting' | 'live' | 'ending' | 'dispatched' | 'error';
type Msg = { id: string; role: OperatorRole; text: string; pending?: boolean };
type Plan = { services: EmergencyService[]; severity: number; category: string };

export function OperatorCallModal({ visible, context, onClose, onDispatched, initialSpeakerOn = true }: Props) {
  const t = useTheme();
  const recorder = useVoiceRecorder();

  const [phase, setPhase] = useState<Phase>('connecting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(44);
  const [sending, setSending] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [speakerOn, setSpeakerOn] = useState(initialSpeakerOn);
  const [plan, setPlan] = useState<Plan>({ services: [], severity: 3, category: 'Other' });
  const [readyToDispatch, setReadyToDispatch] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dispatched, setDispatched] = useState<{ call: EmergencyCall; summary: string | null; key_facts: string[] } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const idCounter = useRef(0);
  const speakerOnRef = useRef(speakerOn);
  speakerOnRef.current = speakerOn;
  const placeName = context?.location_name?.trim() || null;

  const nextId = () => `m${idCounter.current++}`;

  const pushMsg = useCallback((role: OperatorRole, text: string, pending = false): string => {
    const id = nextId();
    setMessages((prev) => [...prev, { id, role, text, pending }]);
    return id;
  }, []);

  const updateMsg = useCallback((id: string, text: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, pending: false } : m)));
  }, []);

  const speak = useCallback((text: string) => {
    if (!speakerOnRef.current || !text) return;
    try {
      Speech.stop();
      Speech.speak(text, { rate: 0.98, pitch: 1.0 });
    } catch {
      /* TTS is best-effort */
    }
  }, []);

  const stopSpeech = useCallback(() => {
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
  }, []);

  // ── Lifecycle: connect on open, fully reset on close ──
  useEffect(() => {
    if (!visible || !context) return;
    let cancelled = false;
    setPhase('connecting');
    setMessages([]);
    setInput('');
    setInputHeight(44);
    setTranscribing(false);
    setVoiceNote(null);
    // Honour the caller's pre-call mute choice (update the ref now so the greeting
    // itself respects it, before the next render syncs it).
    setSpeakerOn(initialSpeakerOn);
    speakerOnRef.current = initialSpeakerOn;
    setPlan({ services: [], severity: 3, category: context.category || 'Other' });
    setReadyToDispatch(false);
    setPhoto(null);
    setCameraOpen(false);
    setDispatched(null);
    setErrorMsg(null);
    setSessionId(null);

    (async () => {
      try {
        const res = await api.operatorStart({
          citizen_id: context.citizen_id,
          caller_lat: context.caller_lat,
          caller_lng: context.caller_lng,
          location_name: context.location_name,
          category: context.category,
          disaster_id: context.disaster_id,
          caller_profile: (context.caller_profile as any) ?? undefined,
        });
        if (cancelled) return;
        setSessionId(res.session_id);
        pushMsg('operator', res.greeting);
        speak(res.greeting);
        setPhase('live');
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(e?.message || 'Could not connect to the 911 operator.');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      stopSpeech();
      recorder.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    // Auto-scroll as the conversation grows.
    const h = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(h);
  }, [messages]);

  // ── Send a reviewed message (typed, or transcribed-then-edited) ──
  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || transcribing || recorder.isRecording || phase !== 'live') return;
    setInput('');
    setInputHeight(44);
    setVoiceNote(null);
    pushMsg('caller', text);
    if (matchesEndCall(text)) {
      await endCall();
      return;
    }
    if (!sessionId) return;
    setSending(true);
    try {
      const res = await api.operatorMessage({ session_id: sessionId, text });
      setPlan({ services: res.services, severity: res.severity, category: res.category });
      if (res.ready_to_dispatch) setReadyToDispatch(true);
      pushMsg('operator', res.reply);
      speak(res.reply);
    } catch (e: any) {
      pushMsg('operator', "I didn't quite catch that. Tell me what's happening and where — then end the call and I'll send help.");
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, sending, transcribing, recorder.isRecording, phase, sessionId, pushMsg, speak]);

  // ── Mic toggle: tap to record, tap again to stop → transcribe into the box ──
  // We DON'T auto-send: the transcription lands in the editable text area so the
  // caller can review/fix it (and keep talking to add more) before sending.
  const toggleMic = useCallback(async () => {
    if (sending || transcribing || phase !== 'live') return;
    if (recorder.isRecording) {
      const clip = await recorder.stop();
      if (!clip) return;
      setTranscribing(true);
      setVoiceNote(null);
      try {
        const res = await api.operatorTranscribe({
          session_id: sessionId ?? undefined,
          audio_base64: clip.base64,
          mime: clip.mime,
        });
        if (res.text) {
          setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${res.text}` : res.text));
        } else {
          setVoiceNote("Couldn't make out the audio — try again or type it.");
        }
      } catch {
        setVoiceNote("Couldn't transcribe just now — please type your message.");
      } finally {
        setTranscribing(false);
      }
    } else {
      setVoiceNote(null);
      await recorder.start();
    }
  }, [sending, transcribing, phase, recorder, sessionId]);

  // ── End the call → finalize + dispatch ──
  const endCall = useCallback(async () => {
    if (!sessionId) return;
    setPhase((p) => (p === 'dispatched' || p === 'ending' ? p : 'ending'));
    stopSpeech();
    try {
      const res = await api.operatorEnd({ session_id: sessionId, idempotency_key: `op-end-${sessionId}`, photo_data_url: photo });
      setDispatched(res);
      setPhase('dispatched');
      onDispatched?.(res.call);
    } catch (e: any) {
      pushMsg('operator', 'I had trouble finalizing the dispatch. Tap “End call & send help” to try again, or close and call directly.');
      setPhase('live');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onDispatched, photo]);

  const closeAll = useCallback(() => {
    stopSpeech();
    recorder.cancel();
    onClose();
  }, [onClose, recorder, stopSpeech]);

  // Open the caller's current position in the device map app, so they can SEE
  // exactly where help is being sent (not just the place name).
  const openLocationOnMap = useCallback(() => {
    if (!context) return;
    const { caller_lat: lat, caller_lng: lng } = context;
    const label = encodeURIComponent(placeName || 'My location');
    const web = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    const url =
      Platform.select({
        ios: `http://maps.apple.com/?ll=${lat},${lng}&q=${label}`,
        android: `geo:${lat},${lng}?q=${lat},${lng}(${label})`,
      }) || web;
    Linking.openURL(url).catch(() => Linking.openURL(web).catch(() => {}));
  }, [context, placeName]);

  if (!context) return null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: t.color.bg }} edges={['top', 'left', 'right', 'bottom']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: t.color.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
            <View style={[styles.liveDot, { backgroundColor: phase === 'dispatched' ? t.color.success : t.color.danger }]} />
            <View style={{ flex: 1 }}>
              <Text variant="h2" numberOfLines={1}>
                {phase === 'dispatched' ? 'Help dispatched' : '911 — Live operator'}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {phase === 'connecting'
                  ? 'Connecting…'
                  : phase === 'ending'
                  ? 'Sending your details…'
                  : phase === 'dispatched'
                  ? 'Responders are on the way'
                  : 'AI emergency operator'}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() => setSpeakerOn((s) => !s)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={speakerOn ? 'Mute operator voice' : 'Unmute operator voice'}
            style={{ marginRight: 16 }}
          >
            <Icon name={speakerOn ? 'volume-high' : 'volume-mute'} size={23} color={speakerOn ? t.color.primary : t.color.textMuted} />
          </Pressable>
          <Pressable onPress={closeAll} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close call">
            <Icon name="close" size={26} color={t.color.textSecondary} />
          </Pressable>
        </View>

        {/* Location auto-share banner — tap to see exactly where help is being sent */}
        <Pressable
          onPress={openLocationOnMap}
          accessibilityRole="button"
          accessibilityLabel="View my current location on the map"
          style={[styles.locBanner, { backgroundColor: t.color.surfaceAlt }]}
        >
          <Icon name="location" size={13} color={t.color.primary} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              Sharing your location: <Text variant="caption" color={t.color.textPrimary}>{placeName || `${context.caller_lat.toFixed(5)}, ${context.caller_lng.toFixed(5)}`}</Text>
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="map" size={13} color={t.color.primary} />
            <Text variant="caption" color={t.color.primary}>View</Text>
          </View>
        </Pressable>

        {/* Live dispatch plan */}
        {plan.services.length > 0 && phase !== 'dispatched' && (
          <View style={styles.planRow}>
            <Text variant="overline" tone="muted">Operator is arranging</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {plan.services.map((s) => (
                <View key={s} style={[styles.chip, { borderColor: t.color.danger, backgroundColor: t.color.surface }]}>
                  <Icon name={serviceIcon(s)} size={12} color={t.color.danger} />
                  <Text variant="caption" color={t.color.danger}>{serviceLabel(s)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Conversation */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: t.spacing.lg, gap: 10 }}
          keyboardShouldPersistTaps="handled"
        >
          {phase === 'error' ? (
            <View style={{ alignItems: 'center', paddingTop: t.spacing.giant }}>
              <IconBadge name="alert" color={t.color.danger} size={56} iconSize={28} />
              <Text variant="h3" center style={{ marginTop: t.spacing.md }}>Couldn't reach the operator</Text>
              <Text variant="body" tone="secondary" center style={{ marginTop: 6 }}>{errorMsg}</Text>
            </View>
          ) : (
            messages.map((m) => <Bubble key={m.id} msg={m} placeName={placeName} />)
          )}

          {dispatched && (
            <DispatchSummary
              services={dispatched.call.requested_services}
              severity={dispatched.call.severity}
              summary={dispatched.summary}
              keyFacts={dispatched.key_facts}
            />
          )}
        </ScrollView>

        {/* Footer / input */}
        <View style={[styles.footer, { borderTopColor: t.color.border }]}>
          {phase === 'connecting' && (
            <View style={styles.centerRow}>
              <ActivityIndicator color={t.color.danger} />
              <Text variant="body" tone="secondary">Connecting to 911…</Text>
            </View>
          )}

          {phase === 'ending' && (
            <View style={styles.centerRow}>
              <ActivityIndicator color={t.color.danger} />
              <Text variant="body" tone="secondary">Sending your details to responders…</Text>
            </View>
          )}

          {phase === 'error' && (
            <Button label="Close" variant="secondary" fullWidth onPress={closeAll} />
          )}

          {phase === 'dispatched' && (
            <Button label="Done" variant="primary" size="lg" fullWidth icon="check" onPress={closeAll} />
          )}

          {phase === 'live' && (
            <>
              {readyToDispatch && (
                <View style={[styles.readyBanner, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.success }]}>
                  <Icon name="check-circle" size={14} color={t.color.success} />
                  <Text variant="caption" color={t.color.success} style={{ flex: 1 }}>
                    The operator has what it needs — end the call to generate the report and send help.
                  </Text>
                </View>
              )}
              {recorder.error && (
                <Text variant="caption" tone="danger" style={{ marginBottom: 6 }}>{recorder.error}</Text>
              )}
              {voiceNote && (
                <Text variant="caption" tone="danger" style={{ marginBottom: 6 }}>{voiceNote}</Text>
              )}

              {/* Live recording meter (real-time mic level + elapsed time). */}
              {recorder.isRecording && (
                <View style={[styles.recBar, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.danger }]}>
                  <View style={[styles.recDot, { backgroundColor: t.color.danger }]} />
                  <Text variant="caption" color={t.color.danger}>{fmtDuration(recorder.durationMs)}</Text>
                  <LevelMeter level={recorder.level} color={t.color.danger} track={t.color.border} />
                  <Text variant="caption" tone="muted">tap ✓ to stop</Text>
                </View>
              )}
              {transcribing && (
                <View style={[styles.recBar, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.border }]}>
                  <ActivityIndicator size="small" color={t.color.primary} />
                  <Text variant="caption" tone="secondary">Transcribing what you said…</Text>
                </View>
              )}

              <View style={styles.inputRow}>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  editable={!sending && !transcribing}
                  placeholder={recorder.isRecording ? 'Listening… your words will appear here to review' : 'Type, or tap the mic to speak…'}
                  placeholderTextColor={t.color.textMuted}
                  onContentSizeChange={(e) =>
                    setInputHeight(Math.max(44, Math.min(150, e.nativeEvent.contentSize.height + 16)))
                  }
                  style={[
                    styles.input,
                    {
                      height: inputHeight,
                      backgroundColor: t.color.surfaceAlt,
                      color: t.color.textPrimary,
                      borderColor: t.color.border,
                    },
                  ]}
                  multiline
                  scrollEnabled
                />
                {/* Mic — tap to record, tap again to transcribe into the box */}
                <Pressable
                  onPress={toggleMic}
                  disabled={sending || transcribing}
                  accessibilityRole="button"
                  accessibilityLabel={recorder.isRecording ? 'Stop and transcribe' : 'Record voice'}
                  style={[
                    styles.iconBtn,
                    {
                      backgroundColor: recorder.isRecording ? t.color.danger : t.color.surface,
                      borderColor: recorder.isRecording ? t.color.danger : t.color.border,
                    },
                  ]}
                >
                  <Icon
                    name={recorder.isRecording ? 'check' : 'radio'}
                    size={22}
                    color={recorder.isRecording ? t.color.alwaysWhite : t.color.textSecondary}
                  />
                </Pressable>
                {/* Send the reviewed message */}
                <Pressable
                  onPress={sendText}
                  disabled={!input.trim() || sending || transcribing || recorder.isRecording}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={[
                    styles.iconBtn,
                    {
                      backgroundColor: input.trim() && !sending && !recorder.isRecording ? t.color.primary : t.color.surface,
                      borderColor: input.trim() && !sending && !recorder.isRecording ? t.color.primary : t.color.border,
                    },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={t.color.textSecondary} />
                  ) : (
                    <Icon name="chevronRight" size={22} color={input.trim() ? t.color.alwaysWhite : t.color.textMuted} />
                  )}
                </Pressable>
              </View>

              <Text variant="caption" tone="muted" center style={{ marginTop: 6 }}>
                Tap the mic to speak — review the text, then Send. Say or type “{END_CALL_HINT}” to hang up.
              </Text>

              {/* Optional photo proof — attached to the call when you end it. */}
              {photo ? (
                <View style={[styles.photoRow, { borderColor: t.color.success, backgroundColor: t.color.surfaceAlt }]}>
                  <Image source={{ uri: photo }} style={styles.photoThumb} resizeMode="cover" accessibilityLabel="Attached photo" />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
                    <Icon name="check-circle" size={14} color={t.color.success} />
                    <Text variant="caption" color={t.color.success}>Photo attached</Text>
                  </View>
                  <Pressable onPress={() => setCameraOpen(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retake photo">
                    <Text variant="caption" color={t.color.primary}>Retake</Text>
                  </Pressable>
                  <Pressable onPress={() => setPhoto(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove photo">
                    <Icon name="trash" size={16} color={t.color.textMuted} />
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setCameraOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Add a photo"
                  style={[styles.addPhoto, { borderColor: t.color.border }]}
                >
                  <Icon name="camera" size={16} color={t.color.textSecondary} />
                  <Text variant="caption" tone="secondary">Add a photo (optional)</Text>
                </Pressable>
              )}

              <Button
                label="End call & send help"
                variant="danger"
                icon="calls"
                fullWidth
                onPress={endCall}
                style={{ marginTop: 10 }}
              />
            </>
          )}
        </View>

        <CameraCapture
          visible={cameraOpen}
          onCancel={() => setCameraOpen(false)}
          onCapture={(dataUrl) => {
            setPhoto(dataUrl);
            setCameraOpen(false);
          }}
        />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

// ── Chat bubble (highlights location shortcuts in caller messages) ──
function Bubble({ msg, placeName }: { msg: Msg; placeName: string | null }) {
  const t = useTheme();
  const isOp = msg.role === 'operator';
  const bg = isOp ? t.color.surface : t.color.primary;
  const fg = isOp ? t.color.textPrimary : t.color.alwaysWhite;

  return (
    <View style={{ alignItems: isOp ? 'flex-start' : 'flex-end' }}>
      {isOp && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 }}>
          <Icon name="person" size={11} color={t.color.primary} />
          <Text variant="overline" tone="accent">Operator</Text>
        </View>
      )}
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: msg.pending ? t.color.surfaceAlt : bg,
            borderColor: isOp ? t.color.border : 'transparent',
            borderWidth: isOp ? 1 : 0,
            borderTopLeftRadius: isOp ? 4 : 16,
            borderTopRightRadius: isOp ? 16 : 4,
          },
        ]}
      >
        {isOp || msg.pending ? (
          <Text variant="body" color={msg.pending ? t.color.textMuted : fg}>{msg.text}</Text>
        ) : (
          <Text variant="body" color={fg}>
            {splitLocationPhrases(msg.text).map((seg, i) =>
              seg.isLocation ? (
                <Text key={i} variant="bodyStrong" color={fg} style={styles.locHighlight}>
                  {seg.text}
                </Text>
              ) : (
                <Text key={i} variant="body" color={fg}>
                  {seg.text}
                </Text>
              ),
            )}
          </Text>
        )}
      </View>
      {!isOp && !msg.pending && hasLocationPhrase(msg.text) && placeName && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 }}>
          <Icon name="location" size={11} color={t.color.textMuted} />
          <Text variant="caption" tone="muted">= {placeName}</Text>
        </View>
      )}
    </View>
  );
}

// ── End-of-call dispatch summary (mirrors what responders receive) ──
function DispatchSummary({
  services,
  severity,
  summary,
  keyFacts,
}: {
  services: EmergencyService[];
  severity: number;
  summary: string | null;
  keyFacts: string[];
}) {
  const t = useTheme();
  return (
    <Card accent={t.color.success} style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: t.spacing.sm }}>
        <IconBadge name="check-circle" color={t.color.success} size={32} iconSize={16} />
        <Text variant="h3">Help is on the way</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: t.spacing.sm }}>
        {services.map((s) => (
          <View key={s} style={[styles.chip, { borderColor: t.color.success, backgroundColor: t.color.surface }]}>
            <Icon name={serviceIcon(s)} size={12} color={t.color.success} />
            <Text variant="caption" color={t.color.success}>{serviceLabel(s)}</Text>
          </View>
        ))}
        <View style={[styles.chip, { borderColor: t.color.border, backgroundColor: t.color.surface }]}>
          <Text variant="caption" tone="muted">severity {severity}/5</Text>
        </View>
      </View>
      {summary ? (
        <>
          <Text variant="overline" tone="muted" style={{ marginBottom: 2 }}>Sent to responders</Text>
          <Text variant="body" tone="secondary">{summary}</Text>
        </>
      ) : null}
      {keyFacts.length > 0 && (
        <View style={{ marginTop: t.spacing.sm, gap: 3 }}>
          {keyFacts.map((f, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
              <Text variant="body" tone="muted">•</Text>
              <Text variant="body" tone="secondary" style={{ flex: 1 }}>{f}</Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

// mm:ss elapsed recording time.
function fmtDuration(ms: number): string {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Live mic input-level bar (fills with the caller's voice volume in real time).
function LevelMeter({ level, color, track }: { level: number; color: string; track: string }) {
  return (
    <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: track, overflow: 'hidden' }}>
      <View style={{ width: `${Math.max(4, Math.round(level * 100))}%`, height: '100%', backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  liveDot: { width: 12, height: 12, borderRadius: 6 },
  locBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingVertical: 8 },
  planRow: { paddingHorizontal: 20, paddingTop: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  bubble: { maxWidth: '88%', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16 },
  locHighlight: { textDecorationLine: 'underline' },
  footer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, borderTopWidth: 1 },
  readyBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, marginBottom: 8 },
  addPhoto: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, paddingVertical: 10, marginTop: 8 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 8, marginTop: 8 },
  photoThumb: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#0002' },
  centerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 150,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 15,
  },
  recBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  recDot: { width: 8, height: 8, borderRadius: 4 },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
