import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/colors';

type Props = {
  label: string;
  value: string;
  accent?: string;
  onPress?: () => void;
};

export function StatCard({ label, value, accent = colors.info, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { borderLeftColor: accent },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: accent }]}>{value}</Text>
      {onPress && <Text style={styles.hint}>Tap for AI insight →</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: 4 },
  value: { fontSize: 28, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 6 },
});
