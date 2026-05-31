// Global 911 launcher. Mounted once at the citizen root so the red 911 button in
// the tab bar can pop the call menu OVER whatever screen the citizen is on — no
// navigating to a separate "call for help" page first. It owns:
//   • the pre-call sheet (confirm intent + how-to-ask tips + start-muted option)
//   • the live AI operator call (OperatorCallModal)
//   • loading the call context (location, profile, active-zone link) on open
// and renders nothing until open911() fires (see lib/sos911).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, MobileCitizen, Disaster } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Button, Icon, IconBadge } from '@/components/ui';
import { OperatorCallModal, OperatorContext } from '@/components/OperatorCallModal';
import { loadProfileOrSeed, AnyProfile } from '@/lib/profile';
import { lookupAreaName } from '@/lib/geocode';
import { disasterRing, pointInPolygon } from '@/lib/geo';
import { useSos911OpenToken } from '@/lib/sos911';
import { navigationRef } from '@/navigation/navigationRef';

type LatLng = { lat: number; lng: number };

// Last-resort coordinates if the caller has no known location at all, so a 911
// call is NEVER blocked.
const FALLBACK_LOC: LatLng = { lat: 40.758, lng: -73.9855 };

// Quick coaching shown before the caller connects — how to ask for help fast.
const HELP_TIPS: string[] = [
  'Stay calm and speak clearly — short sentences are fine.',
  'Say what’s happening: fire, injury, crime, crash, trapped…',
  'Say where — or just say “my location” and we’ll use your map position.',
  'Say who needs help and any danger (smoke, weapons, rising water).',
  'When you’ve told the operator everything, say “end call” — that generates the report and dispatches help.',
];

// Active disasters whose footprint contains the caller's location.
function activeDangersContaining(loc: LatLng | null, disasters: Disaster[]): Disaster[] {
  if (!loc) return [];
  const hits: Disaster[] = [];
  for (const d of disasters) {
    if (d.status !== 'active') continue;
    const ring = disasterRing(d.area_geometry, d.severity);
    if (ring.length < 3) continue;
    if (pointInPolygon(loc, ring)) hits.push(d);
  }
  return hits;
}

function worstDangerContaining(dangers: Disaster[]): Disaster | null {
  if (!dangers.length) return null;
  return [...dangers].sort((a, b) => b.severity - a.severity)[0];
}

export function Sos911Launcher() {
  const t = useTheme();
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const token = useSos911OpenToken();

  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [profile, setProfile] = useState<AnyProfile | null>(null);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [startMuted, setStartMuted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Pull the freshest location / profile / active-disasters for the call.
  const loadContext = useCallback(async () => {
    if (!session) return;
    try {
      setMe(await api.getCitizen(session.userId));
    } catch {
      /* keep last known */
    }
    loadProfileOrSeed(session.userId, 'civilian', undefined, session.name)
      .then((p) => setProfile(p))
      .catch(() => setProfile(null));
    api.listReportedDisasters()
      .then((d) => setDisasters(d))
      .catch(() => {});
  }, [session]);

  // Open the menu whenever the global 911 signal fires.
  const lastToken = useRef(0);
  useEffect(() => {
    if (token === lastToken.current) return;
    lastToken.current = token;
    if (token > 0 && session?.role === 'citizen') {
      setStartMuted(false);
      loadContext();
      setConfirmOpen(true);
    }
  }, [token, session, loadContext]);

  const loc: LatLng | null = me ? { lat: me.lat, lng: me.lng } : null;
  const effectiveLoc = loc ?? FALLBACK_LOC;

  // Reverse-geocode to a place name (only while the menu/call is up).
  useEffect(() => {
    if (!confirmOpen && !modalOpen) return;
    let cancelled = false;
    lookupAreaName(effectiveLoc.lat, effectiveLoc.lng)
      .then((name) => !cancelled && setLocationName(name))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveLoc.lat, effectiveLoc.lng, confirmOpen, modalOpen]);

  const insideDangers = activeDangersContaining(loc, disasters);
  const worstDanger = worstDangerContaining(insideDangers);
  const linkedDisasterId = worstDanger?.id ?? null;

  const operatorContext: OperatorContext | null = session
    ? {
        citizen_id: session.userId,
        caller_lat: effectiveLoc.lat,
        caller_lng: effectiveLoc.lng,
        location_name: locationName,
        category: null,
        disaster_id: linkedDisasterId,
        caller_profile: (profile as Record<string, any> | null) ?? null,
      }
    : null;

  const dispatchedRef = useRef(false);
  const confirmAndStart = () => {
    setConfirmOpen(false);
    dispatchedRef.current = false;
    setModalOpen(true);
  };
  const closeCall = () => {
    setModalOpen(false);
    if (dispatchedRef.current && navigationRef.isReady()) {
      navigationRef.navigate('Map' as never);
    }
  };

  if (!session || session.role !== 'citizen') return null;

  return (
    <>
      {/* Pre-call sheet: confirm intent + coach how to ask + start-muted option */}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setConfirmOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: t.color.bg, paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: t.spacing.md }}>
                <IconBadge name="calls" color={t.color.danger} size={44} />
                <View style={{ flex: 1 }}>
                  <Text variant="h2">Call a 911 operator?</Text>
                  <Text variant="caption" tone="muted">For real emergencies only.</Text>
                </View>
              </View>

              <Text variant="body" tone="secondary" style={{ marginBottom: t.spacing.lg }}>
                You're about to connect to the live emergency operator. Your location and saved profile are shared automatically.
              </Text>

              <Text variant="overline" tone="muted" style={{ marginBottom: t.spacing.sm }}>
                How to ask for help
              </Text>
              <View style={{ gap: 8, marginBottom: t.spacing.lg }}>
                {HELP_TIPS.map((tip, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
                    <Icon name="check-circle" size={16} color={t.color.success} />
                    <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                      {tip}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Start the operator's spoken voice on or muted */}
              <Pressable
                onPress={() => setStartMuted((m) => !m)}
                accessibilityRole="switch"
                accessibilityState={{ checked: startMuted }}
                accessibilityLabel="Mute the operator's voice"
                style={[styles.muteRow, { borderColor: startMuted ? t.color.primary : t.color.border, backgroundColor: t.color.surface }]}
              >
                <Icon name={startMuted ? 'volume-mute' : 'volume-high'} size={20} color={startMuted ? t.color.primary : t.color.textSecondary} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{startMuted ? 'Operator voice muted' : 'Operator voice on'}</Text>
                  <Text variant="caption" tone="muted">
                    {startMuted ? "You'll read the operator's replies silently." : 'The operator will speak its replies aloud.'}
                  </Text>
                </View>
                <View style={[styles.switchTrack, { backgroundColor: startMuted ? t.color.primary : t.color.border }]}>
                  <View style={[styles.switchKnob, { alignSelf: startMuted ? 'flex-end' : 'flex-start' }]} />
                </View>
              </Pressable>

              <Button
                label="Yes, connect me to 911"
                variant="danger"
                size="lg"
                icon="calls"
                fullWidth
                onPress={confirmAndStart}
                style={{ marginTop: t.spacing.lg }}
              />
              <Button label="Cancel" variant="ghost" fullWidth onPress={() => setConfirmOpen(false)} style={{ marginTop: t.spacing.sm }} />
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalOpen} animationType="slide" onRequestClose={closeCall} presentationStyle="fullScreen">
        <OperatorCallModal
          visible={modalOpen}
          context={operatorContext}
          initialSpeakerOn={!startMuted}
          onClose={closeCall}
          onDispatched={() => {
            dispatchedRef.current = true;
          }}
        />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 20, paddingTop: 18, maxHeight: '90%' },
  muteRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 14, padding: 12 },
  switchTrack: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: 'center' },
  switchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
});
