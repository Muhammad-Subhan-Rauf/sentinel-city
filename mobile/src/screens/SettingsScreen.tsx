// Shared Settings screen for all roles.
//   - Citizens & workers: pin-drop map (drag to relocate) + sign-out
//   - Admins: identity caption + sign-out only (no map; admins don't have a position)

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LeafletPicker } from '@/components/LeafletPicker';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { colors, roleAccent } from '@/lib/colors';

const MANHATTAN = { lat: 40.758, lng: -73.9855 };

// Helper: did this thrown error come from a 404 on a /citizens/ or /workers/
// "me" lookup? The api client formats errors as `API 404 /api/citizens/<id>: …`
// so a substring check is the simplest way without bloating the api layer.
function isStaleSession(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /\bAPI 404\b/.test(msg) && /\/api\/(citizens|workers)\//.test(msg);
}

export default function SettingsScreen() {
  const { session, signOut } = useAuth();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const role = session?.role;
  const isField = role === 'citizen' || role === 'worker';
  const accent = roleAccent(role ?? 'citizen');

  // Pull current position from backend for citizens/workers.
  useEffect(() => {
    if (!session || !isField) return;
    let cancelled = false;
    (async () => {
      try {
        const me =
          session.role === 'citizen'
            ? await api.getCitizen(session.userId)
            : await api.getWorker(session.userId);
        if (cancelled) return;
        setPin({ lat: me.lat, lng: me.lng });
      } catch (e) {
        if (cancelled) return;
        // Backend was restarted, wiping its in-memory roster. The phone's
        // stored session is now stale — kick the user back to PIN entry so
        // their next login re-upserts them on the server.
        if (isStaleSession(e)) {
          signOut().catch(() => {});
          return;
        }
        // Otherwise: first time or transient error, fall back to Manhattan
        // so the map can still render.
        setPin(MANHATTAN);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, isField, signOut]);

  const pushLocation = async (loc: { lat: number; lng: number }) => {
    if (!session || !isField) return;
    setSaving(true);
    try {
      if (session.role === 'citizen') {
        await api.updateCitizen(session.userId, { lat: loc.lat, lng: loc.lng });
      } else {
        await api.updateWorker(session.userId, { lat: loc.lat, lng: loc.lng });
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      if (isStaleSession(e)) {
        signOut().catch(() => {});
        return;
      }
      /* swallow other errors; banner could surface them later */
    } finally {
      setSaving(false);
    }
  };

  if (!session) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>
        Signed in as {session.name} · {session.sub_role ?? session.role}
      </Text>

      {isField && (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Change address / location</Text>
            <Text style={styles.sectionHint}>Drag the pin or tap the map to update.</Text>
          </View>
          <View style={styles.mapBox}>
            {pin ? (
              <LeafletPicker
                pin={pin}
                accent={accent}
                onPinChange={(loc) => {
                  setPin(loc);
                  pushLocation(loc);
                }}
              />
            ) : (
              <ActivityIndicator color={colors.info} style={{ marginTop: 24 }} />
            )}
          </View>

          <View style={styles.coordsRow}>
            {pin && (
              <Text style={styles.coords}>
                {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
              </Text>
            )}
            {saving ? (
              <ActivityIndicator color={colors.info} />
            ) : savedAt ? (
              <Text style={styles.savedAt}>Synced {savedAt}</Text>
            ) : null}
          </View>
        </>
      )}

      <Pressable onPress={signOut} style={styles.signOutBtn}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, marginTop: 4, marginBottom: 12 },
  sectionHeader: { marginTop: 4 },
  sectionTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  sectionHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  mapBox: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 12,
    minHeight: 240,
  },
  coordsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  coords: { color: colors.textPrimary, fontSize: 13, fontVariant: ['tabular-nums'] },
  savedAt: { color: colors.success, fontSize: 12 },
  signOutBtn: {
    backgroundColor: colors.danger,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  signOutText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
