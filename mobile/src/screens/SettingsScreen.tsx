// Shared Settings screen for all roles.
//   - Citizens & workers: pin-drop map (drag to relocate) + sign-out
//   - Admins: identity card + sign-out only (no map; admins have no position)

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LeafletPicker } from '@/components/LeafletPicker';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Button, IconBadge, Badge, Icon, SectionHeader, IconName } from '@/components/ui';
import { PlaceLabel } from '@/lib/geocode';
import { ProfileModal } from '@/components/ProfileModal';
import { profileRoleKind } from '@/lib/profile';

const MANHATTAN = { lat: 40.758, lng: -73.9855 };

function isStaleSession(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /\bAPI 404\b/.test(msg) && /\/api\/(citizens|workers)\//.test(msg);
}

export default function SettingsScreen() {
  const t = useTheme();
  const { session, signOut } = useAuth();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const role = session?.role;
  const isField = role === 'citizen' || role === 'worker';
  const profileKind = profileRoleKind(session); // 'civilian' | 'responder' | 'none'

  const accent =
    role === 'citizen'
      ? t.color.citizen
      : role === 'admin'
        ? t.color.admin
        : session?.sub_role === 'firefighter'
          ? t.color.firefighter
          : session?.sub_role === 'police'
            ? t.color.police
            : t.color.paramedic;

  const roleIcon: IconName =
    role === 'admin'
      ? 'shield'
      : role === 'worker'
        ? session?.sub_role === 'firefighter'
          ? 'firefighter'
          : session?.sub_role === 'police'
            ? 'police'
            : 'ambulance'
        : 'person';

  useEffect(() => {
    if (!session || !isField) return;
    let cancelled = false;
    (async () => {
      try {
        const me =
          session.role === 'citizen' ? await api.getCitizen(session.userId) : await api.getWorker(session.userId);
        if (cancelled) return;
        setPin({ lat: me.lat, lng: me.lng });
      } catch (e) {
        if (cancelled) return;
        if (isStaleSession(e)) {
          signOut().catch(() => {});
          return;
        }
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
      setSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      if (isStaleSession(e)) {
        signOut().catch(() => {});
        return;
      }
    } finally {
      setSaving(false);
    }
  };

  if (!session) return null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.color.bg }]} edges={['top', 'left', 'right']}>
      <Text variant="title" style={{ paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.sm, paddingBottom: t.spacing.md }}>
        Settings
      </Text>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={{ marginBottom: t.spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
            <IconBadge name={roleIcon} color={accent} size={52} iconSize={26} />
            <View style={{ flex: 1 }}>
              <Text variant="h2">{session.name}</Text>
              <Badge
                label={(session.sub_role ?? session.role).replace(/^\w/, (c) => c.toUpperCase())}
                color={accent}
                icon="shield"
                style={{ marginTop: 6 }}
              />
            </View>
          </View>
        </Card>

        {profileKind !== 'none' && (
          <Card
            onPress={() => setProfileOpen(true)}
            style={{ marginBottom: t.spacing.lg }}
            accessibilityLabel="Manage profile"
            accessibilityHint={profileKind === 'civilian' ? 'Edit the emergency info shared with 911' : 'Edit your service details'}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
              <IconBadge name={profileKind === 'civilian' ? 'person' : roleIcon} color={accent} size={44} />
              <View style={{ flex: 1 }}>
                <Text variant="h3">Manage profile</Text>
                <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                  {profileKind === 'civilian'
                    ? 'Vitals, medical info & emergency contact — shared with 911 when you call'
                    : 'Badge, unit & service details shown to dispatch'}
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={t.color.textMuted} />
            </View>
          </Card>
        )}

        {isField && (
          <>
            <SectionHeader title="Your location" hint="Drag the pin or tap the map to update where alerts reach you." />
            <Card padded={false} style={{ overflow: 'hidden', height: 340, marginBottom: t.spacing.md }}>
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
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <ActivityIndicator color={t.color.primary} />
                </View>
              )}
            </Card>

            <View style={styles.coordsRow}>
              {pin && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <Icon name="pin" size={14} color={t.color.textMuted} />
                  <PlaceLabel
                    lat={pin.lat}
                    lng={pin.lng}
                    fallback={`${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}
                    variant="caption"
                    tone="secondary"
                    style={{ flex: 1 }}
                  />
                </View>
              )}
              {saving ? (
                <ActivityIndicator color={t.color.primary} />
              ) : savedAt ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name="check-circle" size={14} color={t.color.success} />
                  <Text variant="caption" tone="success">
                    Synced {savedAt}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        )}

        <View style={[styles.appearanceRow, { marginTop: isField ? 4 : t.spacing.lg }]}>
          <Icon name={t.scheme === 'light' ? 'eye' : 'eye-off'} size={14} color={t.color.textMuted} />
          <Text variant="caption" tone="muted" style={{ marginLeft: 6 }}>
            Appearance follows your device ({t.scheme} mode)
          </Text>
        </View>

        <Button label="Sign out" variant="danger" icon="signout" onPress={signOut} />
      </ScrollView>

      {profileKind !== 'none' && (
        <ProfileModal
          visible={profileOpen}
          onClose={() => setProfileOpen(false)}
          userId={session.userId}
          kind={profileKind}
          subRole={session.sub_role}
          name={session.name}
          accent={accent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  coordsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
});
