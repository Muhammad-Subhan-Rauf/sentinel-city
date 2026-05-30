// Direct "call for help" SOS — reachable any time from the red 911 button in the
// citizen tab bar, independent of whether a disaster has been declared. The
// citizen says what's happening (+ optional details), then the same trusted 911
// flow runs (service pick + photo proof + AI authenticity check). The call is
// placed with no disaster_id, so the backend records it as a direct SOS.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Screen } from '@/components/Screen';
import { api, EmergencyService, MobileCitizen } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Button, Icon, IconBadge, IconName } from '@/components/ui';
import { EmergencyCallModal } from '@/components/EmergencyCallModal';

type LatLng = { lat: number; lng: number };

type Category = {
  key: string;
  icon: IconName;
  hint: string;
  accent: (t: ReturnType<typeof useTheme>) => string;
  services: EmergencyService[];
};

const CATEGORIES: Category[] = [
  { key: 'Medical', icon: 'ambulance', hint: 'Injury, illness, unconscious', accent: (t) => t.color.paramedic, services: ['ambulance'] },
  { key: 'Fire', icon: 'firefighter', hint: 'Fire, smoke, gas leak', accent: (t) => t.color.firefighter, services: ['firefighter'] },
  { key: 'Crime', icon: 'police', hint: 'Assault, robbery, threat', accent: (t) => t.color.police, services: ['police'] },
  { key: 'Accident', icon: 'accident', hint: 'Crash, fall, collision', accent: (t) => t.color.warning, services: ['ambulance', 'police'] },
  { key: 'Trapped', icon: 'cordon', hint: 'Stuck, collapse, rising water', accent: (t) => t.color.hazardCordon, services: ['firefighter'] },
  { key: 'Other', icon: 'help-circle', hint: 'Something else — describe it', accent: (t) => t.color.textSecondary, services: [] },
];

function buildSosTranscript(category: string | null, description: string, name: string, loc: LatLng): string {
  const coords = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  return [
    'This is a direct 911 request from Sentinel-City.',
    `Caller: ${name}.`,
    `Location: ${coords}.`,
    category ? `Reported emergency: ${category}.` : null,
    description.trim() ? `Details: ${description.trim()}.` : null,
    'Caller requires immediate assistance. Please dispatch the nearest available unit.',
  ]
    .filter(Boolean)
    .join(' ');
}

export default function CitizenSosScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const navigation = useNavigation<any>();

  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [locating, setLocating] = useState(true);
  const [category, setCategory] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [placingCall, setPlacingCall] = useState(false);
  const [lastCallAt, setLastCallAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  // Refresh the caller's location whenever the screen comes into focus.
  const refreshLocation = useCallback(async () => {
    if (!session) return;
    try {
      const fresh = await api.getCitizen(session.userId);
      setMe(fresh);
    } catch {
      /* keep last known */
    } finally {
      setLocating(false);
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      setLocating(!me);
      refreshLocation();
    }, [refreshLocation]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Drive the cooldown countdown label.
  const cooldownLeftMs = lastCallAt ? Math.max(0, 30_000 - (Date.now() - lastCallAt)) : 0;
  const cooldownActive = cooldownLeftMs > 0;
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!cooldownActive) return;
    tickRef.current = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [cooldownActive]);

  const loc: LatLng | null = me ? { lat: me.lat, lng: me.lng } : null;
  const selected = CATEGORIES.find((c) => c.key === category) ?? null;
  const initialServices = selected?.services ?? [];

  const canStart = !!loc && !cooldownActive && !placingCall;

  const startCall = () => {
    if (!loc) {
      Alert.alert('Location needed', 'We need your location to send help. Set it on the Settings tab, then try again.');
      return;
    }
    setModalOpen(true);
  };

  const submit = async (services: EmergencyService[], photoDataUrl: string | null) => {
    if (!session || !loc || services.length === 0) return;
    setPlacingCall(true);
    try {
      await api.placeEmergencyCall({
        citizen_id: session.userId,
        disaster_id: null,
        category: category ?? 'Other',
        caller_lat: loc.lat,
        caller_lng: loc.lng,
        transcript: buildSosTranscript(category, description, me?.name ?? session.name, loc),
        requested_services: services,
        photo_data_url: photoDataUrl,
      });
      setLastCallAt(Date.now());
      setModalOpen(false);
      setCategory(null);
      setDescription('');
      Alert.alert(
        '911 dispatched',
        `Notified: ${services.join(', ')}.${photoDataUrl ? ' Your photo was sent as proof.' : ''} Your location was shared. Stay safe — help is on the way.`,
        [{ text: 'OK', onPress: () => navigation.navigate('Map') }],
      );
    } catch (e) {
      Alert.alert('Call failed', e instanceof Error ? e.message : 'Could not reach 911 right now. Try again.');
    } finally {
      setPlacingCall(false);
    }
  };

  if (!session) return null;

  return (
    <Screen
      title="Call for help"
      subtitle="Reach 911 from anywhere — add a photo so responders can verify and prioritise your emergency."
    >
      {/* What's happening */}
      <Text variant="overline" tone="muted" style={{ marginBottom: t.spacing.sm }}>
        What's happening?
      </Text>
      <View style={styles.grid}>
        {CATEGORIES.map((c) => {
          const on = category === c.key;
          const accent = c.accent(t);
          return (
            <Pressable
              key={c.key}
              onPress={() => setCategory(on ? null : c.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${c.key}. ${c.hint}`}
              style={({ pressed }) => [
                styles.chip,
                {
                  borderRadius: t.radius.lg,
                  borderColor: on ? accent : t.color.border,
                  backgroundColor: on ? t.color.surfaceHover : t.color.surface,
                  borderWidth: on ? 2 : 1.5,
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
            >
              <IconBadge name={c.icon} color={accent} size={40} />
              <Text variant="bodyStrong" color={on ? accent : t.color.textPrimary} style={{ marginTop: 6 }}>
                {c.key}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={2}>
                {c.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Optional details */}
      <Text variant="overline" tone="muted" style={{ marginTop: t.spacing.lg, marginBottom: t.spacing.sm }}>
        Add details (optional)
      </Text>
      <Card padded={false} style={{ overflow: 'hidden' }}>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Briefly describe what's happening…"
          placeholderTextColor={t.color.textMuted}
          multiline
          maxLength={300}
          style={{
            minHeight: 88,
            padding: t.spacing.md,
            color: t.color.textPrimary,
            fontFamily: t.fonts.regular,
            fontSize: t.fontSize.base,
            textAlignVertical: 'top',
          }}
          accessibilityLabel="Describe your emergency"
        />
      </Card>

      {/* Location status */}
      <View style={[styles.locRow, { marginTop: t.spacing.lg }]}>
        <Icon name={loc ? 'location' : 'offline'} size={14} color={loc ? t.color.success : t.color.textMuted} />
        <Text variant="caption" tone={loc ? 'secondary' : 'muted'} style={{ flex: 1 }}>
          {loc
            ? `Your location will be shared: ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`
            : locating
              ? 'Getting your location…'
              : 'Location unavailable — set it on the Settings tab.'}
        </Text>
      </View>

      {/* Call action */}
      <Button
        label={cooldownActive ? `Just called · wait ${Math.ceil(cooldownLeftMs / 1000)}s` : 'Continue to 911'}
        variant="danger"
        size="lg"
        icon={cooldownActive ? undefined : 'calls'}
        disabled={!canStart}
        onPress={startCall}
        style={{ marginTop: t.spacing.lg }}
      />
      <Text variant="caption" tone="muted" center style={{ marginTop: t.spacing.sm }}>
        You'll choose which services to send and can attach a photo on the next step.
      </Text>

      <EmergencyCallModal
        visible={modalOpen}
        transcript={loc ? buildSosTranscript(category, description, me?.name ?? session.name, loc) : ''}
        submitting={placingCall}
        initialServices={initialServices}
        onCancel={() => setModalOpen(false)}
        onSubmit={submit}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { width: '47.8%', padding: 12, minHeight: 116 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
