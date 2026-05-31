// Turn-by-turn navigation overlay shown while a route is being followed. Renders
// a top "next turn" card (direction icon + distance-to-turn + instruction + a
// "then …" preview) and a bottom bar with ETA, a mute toggle and an End button.
// Speaks each upcoming step via expo-speech, then again when the turn is
// imminent, and announces arrival. Drives off useNavProgress (live location).

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { Route } from '@/lib/api';
import { LatLng } from '@/lib/geo';
import { useTheme } from '@/theme';
import { Text, Icon, IconName, Button } from '@/components/ui';
import { useNavProgress, formatDistance, formatEta } from '@/lib/navigation';

// Valhalla maneuver type → a direction glyph.
function navIcon(type: number): IconName {
  if ([4, 5, 6].includes(type)) return 'flag'; // destination
  if ([12, 13].includes(type)) return 'turn-uturn';
  if ([9, 10, 11, 18, 20, 23].includes(type)) return 'turn-right';
  if ([14, 15, 16, 19, 21, 24].includes(type)) return 'turn-left';
  return 'turn-straight';
}

type Props = { route: Route; location: LatLng | null; onEnd: () => void };

export function NavBanner({ route, location, onEnd }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavProgress(route, location);
  const [muted, setMuted] = useState(false);

  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const spokenStepRef = useRef<number | null>(null);
  const spokenImminentRef = useRef<number | null>(null);
  const arrivedSpokenRef = useRef(false);

  const speak = (text: string) => {
    if (mutedRef.current || !text) return;
    try {
      Speech.stop();
      Speech.speak(text, { rate: 0.95 });
    } catch {
      /* TTS unavailable — banner still guides visually */
    }
  };

  // Announce: new step once → again when imminent → arrival once.
  useEffect(() => {
    if (nav.arrived) {
      if (!arrivedSpokenRef.current) {
        arrivedSpokenRef.current = true;
        speak('You have arrived at your destination.');
      }
      return;
    }
    arrivedSpokenRef.current = false;
    if (!nav.step) return;
    if (spokenStepRef.current !== nav.stepIndex) {
      spokenStepRef.current = nav.stepIndex;
      spokenImminentRef.current = null;
      speak(`In ${formatDistance(nav.distanceToTurnM)}, ${nav.step.verbal}`);
    } else if (nav.distanceToTurnM < 40 && spokenImminentRef.current !== nav.stepIndex) {
      spokenImminentRef.current = nav.stepIndex;
      speak(nav.step.verbal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.stepIndex, nav.distanceToTurnM, nav.arrived]);

  useEffect(
    () => () => {
      try {
        Speech.stop();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const end = () => {
    try {
      Speech.stop();
    } catch {
      /* ignore */
    }
    onEnd();
  };

  const onPrimary = t.color.onPrimary;
  const arrived = nav.arrived;
  const icon: IconName = arrived ? 'flag' : nav.step ? navIcon(nav.step.type) : 'turn-straight';

  return (
    <>
      {/* Top: next-turn card */}
      <View style={[styles.top, { top: insets.top + 8 }]} pointerEvents="none">
        <View style={[styles.turnCard, { backgroundColor: arrived ? t.color.success : t.color.primary, borderRadius: t.radius.lg, ...t.shadow(3) }]}>
          <Icon name={icon} size={36} color={onPrimary} />
          <View style={{ flex: 1, marginLeft: t.spacing.md }}>
            <Text variant="h1" color={onPrimary}>
              {arrived ? 'Arrived' : formatDistance(nav.distanceToTurnM)}
            </Text>
            <Text variant="bodyStrong" color={onPrimary} numberOfLines={2}>
              {arrived ? 'You have reached your destination' : nav.step?.instruction ?? 'Proceed to the route'}
            </Text>
            {!arrived && nav.thenStep ? (
              <Text variant="caption" color={onPrimary} numberOfLines={1} style={{ opacity: 0.85, marginTop: 2 }}>
                then {nav.thenStep.instruction}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Bottom: ETA + mute + End */}
      <View style={[styles.bottom, { bottom: insets.bottom + 16 }]}>
        <View style={[styles.bottomCard, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
          <View style={{ flex: 1 }}>
            <Text variant="h3">{arrived ? 'Done' : formatEta(nav.remainingMin)}</Text>
            <Text variant="caption" tone="secondary">
              {formatDistance(nav.remainingM)} left
            </Text>
          </View>
          <Pressable
            onPress={() => setMuted((m) => !m)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute voice guidance' : 'Mute voice guidance'}
            style={[styles.muteBtn, { backgroundColor: t.color.surfaceAlt }]}
          >
            <Icon name={muted ? 'volume-mute' : 'volume-high'} size={20} color={muted ? t.color.textMuted : t.color.primary} />
          </Pressable>
          <Button label={arrived ? 'Done' : 'End'} variant={arrived ? 'success' : 'danger'} size="md" fullWidth={false} onPress={end} icon={arrived ? 'check' : 'close'} />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 16, right: 16, zIndex: 40 },
  turnCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  bottom: { position: 'absolute', left: 16, right: 16, zIndex: 40 },
  bottomCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 14 },
  muteBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
