// Citizen map — Google Maps style. The user sees their own location, active
// hazards (red/yellow polygons), a tappable destination + a route that avoids
// active hazard polygons (recomputed via Valhalla avoid_polygons), and — when
// standing inside an active zone — a Call 911 button that auto-fills a transcript.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { api, fetchRoute, MobileCitizen, Notification, Cordon, Route, Disaster, EmergencyService } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Button, Icon } from '@/components/ui';
import { disasterRing, pointInPolygon, ringForValhallaAvoid } from '@/lib/geo';
import { EmergencyCallModal } from '@/components/EmergencyCallModal';

type LatLng = { lat: number; lng: number };

function notifsToAvoidPolygons(notifs: Array<Notification | Cordon>): number[][][] {
  const out: number[][][] = [];
  for (const n of notifs) {
    if (n.geometry?.type !== 'Polygon') continue;
    const raw: Array<[number, number]> = n.geometry.coordinates[0] ?? [];
    const safe = ringForValhallaAvoid(raw);
    if (safe.length >= 3) out.push(safe as unknown as number[][]);
  }
  return out;
}

function disastersToAvoidPolygons(disasters: Disaster[]): number[][][] {
  const out: number[][][] = [];
  for (const d of disasters) {
    if (d.status !== 'active') continue;
    const ring = disasterRing(d.area_geometry, d.severity);
    const safe = ringForValhallaAvoid(ring);
    if (safe.length >= 3) out.push(safe as unknown as number[][]);
  }
  return out;
}

function severityWord(sev: number): string {
  return sev >= 5 ? 'critical' : sev >= 4 ? 'severe' : sev >= 3 ? 'major' : sev >= 2 ? 'moderate' : 'minor';
}

function causePhrase(cause: Disaster['cause']): string | null {
  if (cause === 'weather') return 'storm/weather-driven';
  if (cause === 'infrastructure') return 'infrastructure-related';
  return null;
}

function describeZone(d: Disaster): string {
  const type = d.disaster_type.replace(/_/g, ' ').toLowerCase();
  const cause = causePhrase(d.cause);
  return `an active ${type} zone at severity ${d.severity} (${severityWord(d.severity)})${cause ? `, ${cause}` : ''}`;
}

function buildEmergencyTranscript(dangers: Disaster[], callerName: string, caller: LatLng): string {
  const coords = `${caller.lat.toFixed(5)}, ${caller.lng.toFixed(5)}`;
  const head = [
    `This is an automated 911 report from Sentinel-City.`,
    `Caller: ${callerName}.`,
    `Location: ${coords}.`,
  ];
  if (dangers.length === 0) {
    return [...head, `Caller is requesting emergency assistance at this location.`, `Please dispatch the nearest available unit.`].join(' ');
  }
  const sorted = [...dangers].sort((a, b) => b.severity - a.severity);
  let situation: string;
  if (sorted.length === 1) {
    situation = `The caller is inside ${describeZone(sorted[0])}.`;
  } else {
    const primary = describeZone(sorted[0]);
    const rest = sorted.slice(1).map(describeZone).join('; ');
    situation = `The caller is inside ${primary}, overlapping with: ${rest}.`;
  }
  const overlapNote =
    sorted.length > 1 ? `Multiple hazards on scene — ${sorted.length} overlapping zones — coordinate the response.` : null;
  return [...head, situation, overlapNote, `Caller requires immediate assistance. Please dispatch the nearest available unit.`]
    .filter(Boolean)
    .join(' ');
}

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

export default function CitizenMapScreen() {
  const t = useTheme();
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const avoidSignature = useRef<string>('');
  const [modalOpen, setModalOpen] = useState(false);
  const [placingCall, setPlacingCall] = useState(false);
  const [lastCallAt, setLastCallAt] = useState<number | null>(null);
  const [callTranscript, setCallTranscript] = useState<string>('');
  const [callDisasterId, setCallDisasterId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!session) return;
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

  const myLatLng: LatLng | null = me ? { lat: me.lat, lng: me.lng } : null;
  const insideDangers = useMemo(() => activeDangersContaining(myLatLng, disasters), [myLatLng, disasters]);
  const activeCount = disasters.filter((d) => d.status === 'active').length;

  // Announce hazard entry for screen-reader users (once per entry).
  const wasInDanger = useRef(false);
  useEffect(() => {
    const now = insideDangers.length > 0;
    if (now && !wasInDanger.current) {
      AccessibilityInfo.announceForAccessibility(
        `Warning. You are inside an active ${insideDangers[0].disaster_type.replace(/_/g, ' ')} zone. Call 911 is now available.`,
      );
    }
    wasInDanger.current = now;
  }, [insideDangers]);

  const lastDisasterSig = useRef<string>('');
  useEffect(() => {
    if (!destination || !myLatLng) return;
    const sig = JSON.stringify(disastersToAvoidPolygons(disasters));
    if (sig === lastDisasterSig.current) return;
    lastDisasterSig.current = sig;
    computeRoute(myLatLng, destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disasters, destination]);

  const computeRoute = useCallback(async (from: LatLng, to: LatLng) => {
    setRouting(true);
    setRouteError(null);
    try {
      const [notifs, cordons, disastersNow] = await Promise.all([
        api.listNotifications().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Notification[]),
        api.listCordons().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Cordon[]),
        api.listReportedDisasters().catch(() => [] as Disaster[]),
      ]);
      const avoid = [...notifsToAvoidPolygons([...notifs, ...cordons]), ...disastersToAvoidPolygons(disastersNow)];
      avoidSignature.current = JSON.stringify(avoid);
      const r = await fetchRoute(from, to, avoid);
      setRoute(r);
    } catch (err) {
      setRoute(null);
      setRouteError(err instanceof Error ? err.message : 'Could not compute a safe route right now.');
    } finally {
      setRouting(false);
    }
  }, []);

  const meRef = useRef<MobileCitizen | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    if (!destination) return;
    let cancelled = false;
    const tick = async () => {
      const latest = meRef.current;
      if (!latest) return;
      try {
        const [notifs, cordons, disastersNow] = await Promise.all([
          api.listNotifications().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Notification[]),
          api.listCordons().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Cordon[]),
          api.listReportedDisasters().catch(() => [] as Disaster[]),
        ]);
        const sig = JSON.stringify([...notifsToAvoidPolygons([...notifs, ...cordons]), ...disastersToAvoidPolygons(disastersNow)]);
        if (sig !== avoidSignature.current && !cancelled) {
          computeRoute({ lat: latest.lat, lng: latest.lng }, destination);
        }
      } catch {
        /* ignore */
      }
    };
    const handle = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [destination, computeRoute]);

  const onMapPress = (lat: number, lng: number) => {
    if (!myLatLng) return;
    const dest = { lat, lng };
    setDestination(dest);
    computeRoute(myLatLng, dest);
  };

  const clearRoute = () => {
    setDestination(null);
    setRoute(null);
    setRouteError(null);
  };

  const openEmergencyCall = () => {
    if (!session || !myLatLng || insideDangers.length === 0) return;
    const worst = [...insideDangers].sort((a, b) => b.severity - a.severity)[0];
    const transcript = buildEmergencyTranscript(insideDangers, me?.name ?? session.name, myLatLng);
    setCallTranscript(transcript);
    setCallDisasterId(worst.id);
    setModalOpen(true);
  };

  const submitEmergencyCall = async (services: EmergencyService[], photoDataUrl: string | null) => {
    if (!session || !myLatLng || !callDisasterId || services.length === 0) return;
    setPlacingCall(true);
    try {
      await api.placeEmergencyCall({
        citizen_id: session.userId,
        disaster_id: callDisasterId,
        caller_lat: myLatLng.lat,
        caller_lng: myLatLng.lng,
        transcript: callTranscript,
        requested_services: services,
        photo_data_url: photoDataUrl,
      });
      setLastCallAt(Date.now());
      setModalOpen(false);
      Alert.alert(
        '911 dispatched',
        `Notified: ${services.join(', ')}.${photoDataUrl ? ' Your photo was sent as proof.' : ''} They've been given your location and the hazard details. Stay on the line — help is on the way.`,
        [{ text: 'OK' }],
      );
    } catch (e) {
      Alert.alert('Call failed', e instanceof Error ? e.message : 'Could not reach 911 right now. Try again.');
    } finally {
      setPlacingCall(false);
    }
  };

  const cooldownLeftMs = lastCallAt ? Math.max(0, 30_000 - (Date.now() - lastCallAt)) : 0;
  const cooldownActive = cooldownLeftMs > 0;
  const callDisabled = placingCall || cooldownActive || modalOpen;

  if (!session) return null;

  const worstSeverity = insideDangers.length ? Math.max(...insideDangers.map((d) => d.severity)) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
      <DisasterMap
        myLocation={myLatLng}
        myRole="citizen"
        myUserId={session.userId}
        showOtherUsers={false}
        destination={destination}
        route={route}
        onMapPress={onMapPress}
        onDisastersChange={setDisasters}
      />

      {/* In-zone DANGER banner */}
      {insideDangers.length > 0 && (
        <View
          style={[styles.topBanner, { backgroundColor: t.color.danger, borderRadius: t.radius.lg, ...t.shadow(2) }]}
          accessibilityRole="alert"
        >
          <Icon name="alert" size={22} color={t.color.onDanger} />
          <View style={{ flex: 1, marginLeft: t.spacing.md }}>
            <Text variant="h3" color={t.color.onDanger}>
              DANGER · inside an active {insideDangers[0].disaster_type.replace(/_/g, ' ').toLowerCase()} zone
            </Text>
            <Text variant="caption" color={t.color.onDanger} style={{ opacity: 0.92, marginTop: 2 }}>
              Severity {worstSeverity}
              {insideDangers.length > 1 ? ` · ${insideDangers.length - 1} more overlapping` : ''} · tap the map to set a safe route
            </Text>
          </View>
        </View>
      )}

      {/* Advisory banner — hazards nearby but not on you */}
      {insideDangers.length === 0 && activeCount > 0 && (
        <View style={[styles.topBanner, { backgroundColor: t.color.warning, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
          <Icon name="alert" size={20} color={t.color.alwaysWhite} />
          <Text variant="bodyStrong" color={t.color.alwaysWhite} style={{ flex: 1, marginLeft: t.spacing.md }}>
            {activeCount} active danger zone{activeCount === 1 ? '' : 's'} nearby — stay clear of red areas
          </Text>
        </View>
      )}

      {/* Call 911 — only inside an active zone */}
      {insideDangers.length > 0 && (
        <Pressable
          onPress={openEmergencyCall}
          disabled={callDisabled}
          accessibilityRole="button"
          accessibilityLabel={cooldownActive ? `Call 911, available in ${Math.ceil(cooldownLeftMs / 1000)} seconds` : 'Call 911'}
          accessibilityState={{ disabled: callDisabled }}
          style={({ pressed }) => [
            styles.call911,
            {
              backgroundColor: cooldownActive ? t.color.surfaceAlt : pressed ? t.color.dangerStrong : t.color.danger,
              borderRadius: t.radius.lg,
              borderWidth: cooldownActive ? 1 : 0,
              borderColor: t.color.border,
              ...t.shadow(3),
            },
          ]}
        >
          <Icon name="calls" size={24} color={cooldownActive ? t.color.textMuted : t.color.onDanger} />
          <Text variant="h2" color={cooldownActive ? t.color.textMuted : t.color.onDanger} style={{ letterSpacing: 0.5 }}>
            {cooldownActive ? `Just called · ${Math.ceil(cooldownLeftMs / 1000)}s` : 'Call 911'}
          </Text>
        </Pressable>
      )}

      <EmergencyCallModal
        visible={modalOpen}
        transcript={callTranscript}
        submitting={placingCall}
        onCancel={() => setModalOpen(false)}
        onSubmit={submitEmergencyCall}
      />

      {/* Destination / route panel */}
      <Card style={styles.routePanel} elevation={2}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={destination ? 'route' : 'location'} size={16} color={t.color.primary} />
            <Text variant="bodyStrong" style={{ flex: 1 }}>
              {destination ? 'Safe route set' : 'Tap the map to choose a destination'}
            </Text>
          </View>
          {route && !routing && (
            <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
              {route.distanceKm.toFixed(1)} km · ~{Math.round(route.durationMin)} min · avoiding active hazards
            </Text>
          )}
          {routing && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <ActivityIndicator color={t.color.primary} size="small" />
              <Text variant="caption" tone="secondary">
                Calculating safer path…
              </Text>
            </View>
          )}
          {routeError && (
            <Text variant="caption" tone="danger" style={{ marginTop: 4 }}>
              {routeError}
            </Text>
          )}
        </View>
        {destination && <Button label="Clear" variant="secondary" size="sm" fullWidth={false} onPress={clearRoute} />}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  topBanner: {
    position: 'absolute',
    top: 64,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  call911: {
    position: 'absolute',
    bottom: 112,
    left: 16,
    right: 16,
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  routePanel: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
