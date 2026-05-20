import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';

const PIN_LENGTH = 4;

const HELPER_ROWS: Array<{ label: string; pattern: string; tone: string }> = [
  { label: 'Citizen', pattern: '1 _ _ 1', tone: colors.citizen },
  { label: 'Firefighter', pattern: '2 _ _ 2', tone: colors.warning },
  { label: 'Police', pattern: '3 _ _ 3', tone: colors.info },
  { label: 'Ambulance', pattern: '4 _ _ 4', tone: colors.success },
  { label: 'Admin', pattern: '5 _ _ 5', tone: colors.admin },
];

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const shake = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(t);
  }, []);

  const triggerShake = () => {
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, { toValue: 10, duration: 60, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shake, { toValue: -10, duration: 60, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shake, { toValue: 6, duration: 60, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shake, { toValue: -6, duration: 60, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shake, { toValue: 0, duration: 60, useNativeDriver: true, easing: Easing.linear }),
    ]).start();
  };

  // Blur+focus toggle. On Android, calling .focus() on an input that the
  // framework already considers focused is a no-op and the soft keyboard
  // doesn't re-appear — pressing the pin slots ends up doing nothing visible
  // after a failed submit. Toggling forces the keyboard back up.
  const refocusInput = () => {
    const input = inputRef.current;
    if (!input) return;
    input.blur();
    // requestAnimationFrame so the blur lands before the focus, and so we
    // run after any state-change re-render (e.g. busy → false flipping
    // `editable` back on after a failed submit).
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSubmit = async (value: string) => {
    if (value.length !== PIN_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(value);
      // On success the navigator switches automatically; nothing else to do.
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const userFacing = msg.includes('401') ? 'Invalid PIN' : 'Login failed — check connection';
      setError(userFacing);
      setPin('');
      triggerShake();
    } finally {
      setBusy(false);
      // Refocus AFTER busy is cleared (and the editable prop is back to true)
      // so the native widget actually accepts focus.
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
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.brand}>Sentinel-City</Text>
        <Text style={styles.tagline}>Enter your PIN</Text>
      </View>

      <Pressable onPress={refocusInput} style={{ alignItems: 'center' }}>
        <Animated.View
          style={[
            styles.pinRow,
            error && styles.pinRowError,
            { transform: [{ translateX: shake }] },
          ]}
        >
          {pinSlots.map((digit, idx) => (
            <View
              key={idx}
              style={[styles.pinSlot, digit !== '' && styles.pinSlotFilled]}
            >
              <Text style={styles.pinDigit}>{digit ? '•' : ''}</Text>
            </View>
          ))}
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

      {error && <Text style={styles.errorText}>{error}</Text>}
      {busy && <ActivityIndicator color={colors.info} style={{ marginTop: 16 }} />}

      <View style={styles.helperBox}>
        <Text style={styles.helperTitle}>PIN patterns</Text>
        {HELPER_ROWS.map((row) => (
          <View key={row.label} style={styles.helperRow}>
            <View style={[styles.helperDot, { backgroundColor: row.tone }]} />
            <Text style={styles.helperLabel}>{row.label}</Text>
            <Text style={styles.helperPattern}>{row.pattern}</Text>
          </View>
        ))}
        <Text style={styles.helperFootnote}>
          First and last digit are equal. Middle digits are free.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 24 },
  header: { marginTop: 40, marginBottom: 36, alignItems: 'center' },
  brand: { color: colors.textPrimary, fontSize: 32, fontWeight: '800' },
  tagline: { color: colors.textSecondary, marginTop: 8, fontSize: 14 },
  pinRow: {
    flexDirection: 'row',
    gap: 12,
    marginVertical: 8,
  },
  pinRowError: {},
  pinSlot: {
    width: 52,
    height: 64,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinSlotFilled: {
    borderColor: colors.info,
    backgroundColor: colors.surfaceAlt,
  },
  pinDigit: { color: colors.textPrimary, fontSize: 28, fontWeight: '700' },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 1,
    width: 1,
  },
  errorText: {
    color: colors.danger,
    marginTop: 16,
    textAlign: 'center',
    fontWeight: '600',
  },
  helperBox: {
    marginTop: 'auto',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  helperTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  helperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  helperDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  helperLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
  },
  helperPattern: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 14,
    letterSpacing: 2,
  },
  helperFootnote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
  },
});
