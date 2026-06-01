// Shared Settings screen for all roles.
//   - Citizens & workers: pin-drop map (drag to relocate) + sign-out
//   - Admins: identity card + sign-out only (no map; admins have no position)

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LeafletPicker } from '@/components/LeafletPicker';
import { useAuth, isStaleSession } from '@/lib/auth';
import { api } from '@/lib/api';
import { useTheme } from '@/theme';
import { Text, Card, Button, IconBadge, Badge, Icon, SectionHeader, IconName } from '@/components/ui';
import { PlaceLabel } from '@/lib/geocode';
import { ProfileModal } from '@/components/ProfileModal';
import { profileRoleKind, loadProfileOrSeed, AnyProfile } from '@/lib/profile';

const MANHATTAN = { lat: 40.758, lng: -73.9855 };

type WorkerStatus = 'available' | 'dispatched' | 'on_scene' | 'off_duty';

export default function SettingsScreen() {
  const t = useTheme();
  const { session, signOut } = useAuth();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Worker-only: current duty status. Reflects the backend value; we let the
  // user flip between 'available' (online) and 'off_duty' (away) here. The
  // other two values — 'dispatched' / 'on_scene' — are set automatically by
  // the call lifecycle and shown as a read-only state with a hint.
  const [dutyStatus, setDutyStatus] = useState<WorkerStatus | null>(null);
  const [dutySaving, setDutySaving] = useState(false);
  // Saved profile — its fullName is the identity name shown on this screen
  // (the editable one), so an edit reflects here immediately.
  const [profile, setProfile] = useState<AnyProfile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const role = session?.role;
  const isField = role === 'citizen' || role === 'worker';
  const isWorker = role === 'worker';
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
        if (session.role === 'worker') setDutyStatus((me as any).status as WorkerStatus);
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

  // Poll worker status so the duty card stays in sync with auto-transitions
  // (acknowledge → dispatched, close → available) made from other screens.
  useEffect(() => {
    if (!session || !isWorker) return;
    let cancelled = false;
    const handle = setInterval(async () => {
      try {
        const w = await api.getWorker(session.userId);
        if (!cancelled) setDutyStatus(w.status as WorkerStatus);
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [session, isWorker]);

  // Load the saved profile so the identity card shows the editable full name.
  useEffect(() => {
    if (!session || profileKind === 'none') {
      setProfile(null);
      return;
    }
    let cancelled = false;
    loadProfileOrSeed(session.userId, profileKind, session.sub_role, session.name)
      .then((p) => !cancelled && setProfile(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, profileKind]);

  const setDuty = async (next: 'available' | 'off_duty') => {
    if (!session || !isWorker || dutySaving) return;
    setDutySaving(true);
    try {
      const updated = await api.updateWorker(session.userId, { status: next });
      setDutyStatus(updated.status as WorkerStatus);
    } catch {
      /* surface inline later */
    } finally {
      setDutySaving(false);
    }
  };

  // Sign-out is destructive in a safety app — confirm so an accidental tap
  // mid-emergency can't drop the user out of the app.
  const confirmSignOut = () => {
    Alert.alert('Sign out?', "You'll need your PIN to sign back in.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut().catch(() => {}) },
    ]);
  };

  const dutyLocked = dutyStatus === 'dispatched' || dutyStatus === 'on_scene';

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
              <Text variant="h2">{profile?.fullName?.trim() ? profile.fullName : session.name}</Text>
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

        {isWorker && (
          <>
            <SectionHeader title="Duty status" hint="Toggle whether dispatch can route new calls to you. Locked while you're handling a call." />
            <Card style={{ marginBottom: t.spacing.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
                <IconBadge
                  name={dutyStatus === 'available' ? 'shield-check' : dutyStatus === 'off_duty' ? 'offline' : 'radio'}
                  color={
                    dutyStatus === 'available'
                      ? t.color.success
                      : dutyStatus === 'off_duty'
                        ? t.color.textMuted
                        : t.color.warning
                  }
                  size={44}
                />
                <View style={{ flex: 1 }}>
                  <Text variant="h3">
                    {dutyStatus === 'available'
                      ? 'On duty'
                      : dutyStatus === 'off_duty'
                        ? 'Off duty'
                        : dutyStatus === 'dispatched'
                          ? 'Dispatched'
                          : dutyStatus === 'on_scene'
                            ? 'On scene'
                            : 'Loading…'}
                  </Text>
                  <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                    {dutyLocked
                      ? 'Set automatically while a call is active — finish or close the call to change.'
                      : dutyStatus === 'available'
                        ? 'Dispatch can route new 911 calls to you.'
                        : 'Dispatch will skip you for new calls.'}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="On duty"
                    icon="shield-check"
                    variant={dutyStatus === 'available' ? 'primary' : 'secondary'}
                    onPress={() => setDuty('available')}
                    disabled={dutyLocked || dutySaving || dutyStatus === 'available'}
                    loading={dutySaving && dutyStatus !== 'available'}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Off duty"
                    icon="offline"
                    variant={dutyStatus === 'off_duty' ? 'primary' : 'secondary'}
                    onPress={() => setDuty('off_duty')}
                    disabled={dutyLocked || dutySaving || dutyStatus === 'off_duty'}
                    loading={dutySaving && dutyStatus !== 'off_duty'}
                  />
                </View>
              </View>
            </Card>
          </>
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

        <Button label="Sign out" variant="danger" icon="signout" onPress={confirmSignOut} />
      </ScrollView>

      {profileKind !== 'none' && (
        <ProfileModal
          visible={profileOpen}
          onClose={() => setProfileOpen(false)}
          onSaved={(p) => {
            setProfile(p);
            showToast('Profile updated');
          }}
          userId={session.userId}
          kind={profileKind}
          subRole={session.sub_role}
          name={session.name}
          accent={accent}
        />
      )}

      {toast && (
        <View style={styles.toastWrap} pointerEvents="none">
          <View style={[styles.toast, { backgroundColor: t.color.surfaceAlt, borderColor: t.color.border, borderRadius: t.radius.pill, ...t.shadow(2) }]}>
            <Icon name="check-circle" size={16} color={t.color.success} />
            <Text variant="label">{toast}</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  coordsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 90, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1 },
});
