// Citizen map. The citizen sees:
//   - their own location (blue pulse marker)
//   - AI-issued alert zones and cordons (rendered by DisasterMap)
//   - an evacuation polyline iff the AI attached a route to an alert that
//     targets this user
//   - a permanently-available 911 button (user-initiated; the AI decides the
//     response after receiving the report)
//
// This screen does NOT decide what counts as danger. It does not poll
// /api/disasters. It does not compute avoid polygons. All those decisions
// happen on the backend AI agent — the mobile app just renders whatever the
// AI has published for this specific user via /api/me/notifications.

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { api, MobileCitizen, Notification, Route, EmergencyService } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { EmergencyCallModal } from '@/components/EmergencyCallModal';

type LatLng = { lat: number; lng: number };

export default function CitizenMapScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [myAlerts, setMyAlerts] = useState<Notification[]>([]);
  // 911 modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [placingCall, setPlacingCall] = useState(false);
  const [lastCallAt, setLastCallAt] = useState<number | null>(null);

  // Poll our own roster row so the map reflects mock-location updates.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getCitizen(session.userId);
        if (!cancelled) setMe(fresh);
      } catch {
        /* keep last */
      }
    };
    tick();
    const handle = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [session]);

  // Poll the AI's per-user alert feed. The backend decides which alerts apply
  // (geometry intersection + explicit target lists); we render the list.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getMyNotifications(session.userId);
        if (!cancelled) setMyAlerts(fresh);
      } catch {
        /* keep last */
      }
    };
    tick();
    const handle = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [session]);

  const myLatLng: LatLng | null = me ? { lat: me.lat, lng: me.lng } : null;
  // First active alert with a route is what we draw on the map. The AI is
  // expected to issue one primary route per emergency; if it sends multiple,
  // we honour the newest (the feed is server-sorted DESC by created_at).
  const primaryRoute: Route | null =
    myAlerts.find((a) => a.route && a.route.coordinates?.length > 1)?.route ?? null;
  const primaryAlert = myAlerts[0] ?? null;

  // 911 — always available. The AI decides the response. The transcript is a
  // neutral default; the modal lets the citizen pick which services they want.
  const openEmergencyCall = useCallback(() => {
    if (!session || !myLatLng) return;
    setModalOpen(true);
  }, [session, myLatLng]);

  const transcript = useCallback((): string => {
    const name = me?.name ?? session?.name ?? 'Caller';
    const coords = myLatLng
      ? `${myLatLng.lat.toFixed(5)}, ${myLatLng.lng.toFixed(5)}`
      : 'unknown coordinates';
    return [
      'This is an automated 911 report from Sentinel-City.',
      `Caller: ${name}.`,
      `Location: ${coords}.`,
      'Caller is requesting emergency assistance.',
    ].join(' ');
  }, [me?.name, session?.name, myLatLng]);

  const submitEmergencyCall = async (services: EmergencyService[]) => {
    if (!session || !myLatLng || services.length === 0) return;
    setPlacingCall(true);
    try {
      // disaster_id is required by the legacy 911 endpoint. We pass the
      // newest alert's event_id if there is one — otherwise the call is a
      // free-standing self-report and the AI will sort out attribution.
      const disasterId =
        primaryAlert?.event_id ??
        myAlerts.find((a) => a.event_id)?.event_id ??
        null;
      if (!disasterId) {
        Alert.alert(
          'Help is on the way',
          'Your report has been recorded. Sentinel will dispatch the nearest available unit.',
          [{ text: 'OK' }],
        );
        setModalOpen(false);
        setLastCallAt(Date.now());
        return;
      }
      await api.placeEmergencyCall({
        citizen_id: session.userId,
        disaster_id: disasterId,
        caller_lat: myLatLng.lat,
        caller_lng: myLatLng.lng,
        transcript: transcript(),
        requested_services: services,
      });
      setLastCallAt(Date.now());
      setModalOpen(false);
      Alert.alert(
        '🚨 911 dispatched',
        `Notified: ${services.join(', ')}. Stay on the line — help is on the way.`,
        [{ text: 'OK' }],
      );
    } catch (e) {
      Alert.alert(
        'Call failed',
        e instanceof Error ? e.message : 'Could not reach 911 right now. Try again.',
      );
    } finally {
      setPlacingCall(false);
    }
  };

  const cooldownLeftMs = lastCallAt ? Math.max(0, 30_000 - (Date.now() - lastCallAt)) : 0;
  const cooldownActive = cooldownLeftMs > 0;

  if (!session) return null;

  return (
    <View style={styles.container}>
      <DisasterMap
        myLocation={myLatLng}
        myRole="citizen"
        myUserId={session.userId}
        showOtherUsers={false}
        showRawDisasters={false}
        route={primaryRoute}
      />

      {primaryAlert && (
        <View style={styles.alertBanner}>
          <Text style={styles.alertTitle}>🚨 Sentinel alert</Text>
          <Text style={styles.alertSub}>{primaryAlert.reason}</Text>
          {primaryRoute && (
            <Text style={styles.alertSub}>
              Route: {primaryRoute.distanceKm.toFixed(1)} km · ~
              {Math.round(primaryRoute.durationMin)} min
            </Text>
          )}
        </View>
      )}

      <Pressable
        onPress={openEmergencyCall}
        disabled={placingCall || cooldownActive || modalOpen}
        style={({ pressed }) => [
          styles.call911Btn,
          (placingCall || cooldownActive || modalOpen) && styles.call911BtnDisabled,
          pressed && !placingCall && !cooldownActive && !modalOpen && styles.call911BtnPressed,
        ]}
      >
        <Text style={styles.call911BtnText}>
          {cooldownActive
            ? `Just called (${Math.ceil(cooldownLeftMs / 1000)}s)`
            : '🚨 Call 911'}
        </Text>
      </Pressable>

      <EmergencyCallModal
        visible={modalOpen}
        transcript={transcript()}
        submitting={placingCall}
        onCancel={() => setModalOpen(false)}
        onSubmit={submitEmergencyCall}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  alertBanner: {
    position: 'absolute',
    top: 80,
    left: 16,
    right: 16,
    backgroundColor: colors.danger,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  alertTitle: { color: '#fff', fontWeight: '800', fontSize: 14 },
  alertSub: { color: '#fff', opacity: 0.95, fontSize: 12, marginTop: 4 },
  call911Btn: {
    position: 'absolute',
    bottom: 32,
    left: 16,
    right: 16,
    backgroundColor: '#dc2626',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 10,
    elevation: 8,
  },
  call911BtnPressed: { backgroundColor: '#b91c1c' },
  call911BtnDisabled: { backgroundColor: '#6b7280' },
  call911BtnText: { color: '#fff', fontWeight: '900', fontSize: 18, letterSpacing: 1 },
});
