import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DEMO_USERS, useAuth } from '@/lib/auth';
import type { Role } from '@/lib/api';
import { colors, roleAccent } from '@/lib/colors';

const ROLE_LABEL: Record<Role, string> = {
  citizen: 'Citizen',
  worker: 'Emergency Worker',
  admin: 'Administrator',
};

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Role | 'all'>('all');

  const visible = DEMO_USERS.filter((u) => filter === 'all' || u.role === filter);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.brand}>Sentinel-City</Text>
        <Text style={styles.tagline}>Municipal emergency orchestration</Text>
      </View>

      <View style={styles.filterRow}>
        {(['all', 'citizen', 'worker', 'admin'] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}
          >
            <Text
              style={[
                styles.filterText,
                filter === f && { color: colors.textPrimary, fontWeight: '700' },
              ]}
            >
              {f === 'all' ? 'All' : ROLE_LABEL[f]}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.list}>
        {visible.map((u) => {
          const accent = roleAccent(u.role);
          const loading = busy === u.id;
          return (
            <Pressable
              key={u.id}
              disabled={busy !== null}
              onPress={async () => {
                setBusy(u.id);
                try {
                  await signIn({ role: u.role, userId: u.id, name: u.name });
                } finally {
                  setBusy(null);
                }
              }}
              style={({ pressed }) => [
                styles.userCard,
                { borderLeftColor: accent },
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={[styles.avatar, { backgroundColor: accent }]}>
                <Text style={styles.avatarText}>{u.name.charAt(0)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.name}</Text>
                <Text style={styles.userSub}>{u.subtitle}</Text>
              </View>
              <View style={[styles.roleBadge, { backgroundColor: `${accent}22`, borderColor: accent }]}>
                <Text style={[styles.roleBadgeText, { color: accent }]}>{ROLE_LABEL[u.role]}</Text>
              </View>
              {loading && <ActivityIndicator color={accent} style={{ marginLeft: 8 }} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.footnote}>
        Demo mode · Pick any profile to enter. Sessions persist across launches.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { marginTop: 20, marginBottom: 24, alignItems: 'center' },
  brand: { color: colors.textPrimary, fontSize: 32, fontWeight: '800' },
  tagline: { color: colors.textSecondary, marginTop: 6, fontSize: 14 },
  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  filterChipActive: { backgroundColor: colors.surfaceAlt, borderColor: colors.info },
  filterText: { color: colors.textSecondary, fontSize: 13 },
  list: { gap: 10, flex: 1 },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  userName: { color: colors.textPrimary, fontWeight: '600', fontSize: 15 },
  userSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  roleBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  roleBadgeText: { fontSize: 11, fontWeight: '700' },
  footnote: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 16 },
});
