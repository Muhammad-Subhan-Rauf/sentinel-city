import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, IconBadge, Badge, Icon, IconName } from '@/components/ui';

const PIN_LENGTH = 4;

type RoleHint = { label: string; pattern: string; icon: IconName; tone: (t: ReturnType<typeof useTheme>) => string };

const ROLE_HINTS: RoleHint[] = [
  { label: 'Citizen', pattern: '1 · · 1', icon: 'person', tone: (t) => t.color.citizen },
  { label: 'Firefighter', pattern: '2 · · 2', icon: 'firefighter', tone: (t) => t.color.firefighter },
  { label: 'Police', pattern: '3 · · 3', icon: 'police', tone: (t) => t.color.police },
  { label: 'Ambulance', pattern: '4 · · 4', icon: 'ambulance', tone: (t) => t.color.paramedic },
  { label: 'Admin', pattern: '5 · · 5', icon: 'shield', tone: (t) => t.color.admin },
];

export default function LoginScreen() {
  const t = useTheme();
  const { signIn } = useAuth();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const shake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(id);
  }, []);

  const triggerShake = () => {
    if (t.reduceMotion) return;
    shake.setValue(0);
    Animated.sequence(
      [10, -10, 6, -6, 0].map((to) =>
        Animated.timing(shake, { toValue: to, duration: 60, useNativeDriver: true, easing: Easing.linear }),
      ),
    ).start();
  };

  // Blur+focus toggle so the soft keyboard reliably re-appears after a failed
  // submit (Android no-ops .focus() on an already-"focused" input).
  const refocusInput = () => {
    const input = inputRef.current;
    if (!input) return;
    input.blur();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSubmit = async (value: string) => {
    if (value.length !== PIN_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(value);
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const userFacing = msg.includes('401') ? 'Invalid PIN' : 'Login failed — check connection';
      setError(userFacing);
      AccessibilityInfo.announceForAccessibility(userFacing);
      setPin('');
      triggerShake();
    } finally {
      setBusy(false);
      refocusInput();
    }
  };

  const onChange = (next: string) => {
    const digits = next.replace(/[^0-9]/g, '').slice(0, PIN_LENGTH);
    setPin(digits);
    if (error) setError(null);
    if (digits.length === PIN_LENGTH) handleSubmit(digits);
  };

  const pinSlots = Array.from({ length: PIN_LENGTH }, (_, i) => pin[i] ?? '');

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.color.bg }]}>
      <View style={styles.header}>
        <IconBadge name="shield" color={t.color.primary} size={72} iconSize={36} />
        <Text variant="display" style={{ marginTop: t.spacing.lg }}>
          Sentinel-City
        </Text>
        <Text variant="callout" tone="secondary" style={{ marginTop: 4 }}>
          Enter your PIN to continue
        </Text>
      </View>

      <Pressable onPress={refocusInput} style={{ alignItems: 'center' }} accessibilityRole="button" accessibilityLabel="PIN entry">
        <Animated.View style={[styles.pinRow, { transform: [{ translateX: shake }] }]}>
          {pinSlots.map((digit, idx) => {
            const filled = digit !== '';
            return (
              <View
                key={idx}
                style={[
                  styles.pinSlot,
                  {
                    borderColor: error ? t.color.danger : filled ? t.color.primary : t.color.border,
                    backgroundColor: filled ? t.color.primarySoft : t.color.surface,
                  },
                ]}
              >
                {filled ? <View style={[styles.pinDotFill, { backgroundColor: t.color.primary }]} /> : null}
              </View>
            );
          })}
        </Animated.View>
      </Pressable>

      <TextInput
        ref={inputRef}
        value={pin}
        onChangeText={onChange}
        keyboardType="number-pad"
        maxLength={PIN_LENGTH}
        secureTextEntry
        autoFocus
        editable={!busy}
        style={styles.hiddenInput}
      />

      <View style={styles.statusRow}>
        {busy ? (
          <ActivityIndicator color={t.color.primary} />
        ) : error ? (
          <View style={styles.errorRow}>
            <Icon name="alert" size={16} color={t.color.danger} />
            <Text variant="bodyStrong" tone="danger">
              {error}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={{ flex: 1 }} />

      <Card padded style={{ padding: t.spacing.lg }}>
        <Text variant="overline" tone="muted" style={{ marginBottom: t.spacing.md }}>
          PIN Patterns
        </Text>
        {ROLE_HINTS.map((row) => (
          <View key={row.label} style={styles.hintRow}>
            <IconBadge name={row.icon} color={row.tone(t)} size={34} iconSize={18} />
            <Text variant="bodyStrong" style={{ flex: 1, marginLeft: t.spacing.md }}>
              {row.label}
            </Text>
            <Badge label={row.pattern} color={row.tone(t)} />
          </View>
        ))}
        <View style={[styles.footnoteRow, { borderTopColor: t.color.divider }]}>
          <Icon name="info" size={14} color={t.color.textMuted} />
          <Text variant="caption" tone="muted" style={{ flex: 1, marginLeft: 6 }}>
            First and last digit match your role. The middle two digits are free.
          </Text>
        </View>
      </Card>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 24, paddingTop: 8 },
  header: { marginTop: 36, marginBottom: 32, alignItems: 'center' },
  pinRow: { flexDirection: 'row', gap: 14, marginVertical: 8 },
  pinSlot: {
    width: 56,
    height: 68,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDotFill: { width: 16, height: 16, borderRadius: 8 },
  hiddenInput: { position: 'absolute', opacity: 0, height: 1, width: 1 },
  statusRow: { height: 36, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hintRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  footnoteRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
});
