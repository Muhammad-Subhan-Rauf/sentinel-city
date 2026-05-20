// Citizen map — Google Maps style. The user sees:
//   - their own location (blue pulse marker, distinct from any other dot)
//   - active hazards (red/yellow polygons)
//   - NO other citizens (privacy-by-default)
//   - a tappable destination + route line that avoids active hazard polygons
//
// Rerouting: whenever the active hazard set changes, we recompute the route
// using Valhalla's avoid_polygons feature so the citizen is steered around
// the disaster automatically.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { api, fetchRoute, MobileCitizen, Notification, Cordon, Route, Disaster, EmergencyService } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { disasterRing, pointInPolygon, ringForValhallaAvoid } from '@/lib/geo';
import { EmergencyCallModal } from '@/components/EmergencyCallModal';

type LatLng = { lat: number; lng: number };

function notifsToAvoidPolygons(notifs: Array<Notification | Cordon>): number[][][] {
  // Valhalla wants [[[lng, lat], ...]] per polygon, and rejects anything
  // whose perimeter exceeds 10 km — so we run every ring through
  // ringForValhallaAvoid before forwarding.
  const out: number[][][] = [];
  for (const n of notifs) {
    if (n.geometry?.type !== 'Polygon') continue;
    const raw: Array<[number, number]> = n.geometry.coordinates[0] ?? [];
    const safe = ringForValhallaAvoid(raw);
    if (safe.length >= 3) out.push(safe as unknown as number[][]);
  }
  return out;
}

// Active disaster footprints (Wildfire / Flood / Building_Fire / etc.). Point
// disasters become a severity-scaled circle; oversized polygons get
// down-sampled to a Valhalla-safe circumference.
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

// Pre-built call script the citizen "speaks" when they tap Call 911.
// The transcript adapts to *every* active zone the caller is currently inside
// — dispatch needs the full picture, not just the worst one, because a wildfire
// overlapping a flood is a very different ask from a flood alone. Pure function
// of the disaster set + caller so what the citizen sees is exactly what gets
// spoken and POSTed.
function severityWord(sev: number): string {
  return sev >= 5
    ? 'critical'
    : sev >= 4
      ? 'severe'
      : sev >= 3
        ? 'major'
        : sev >= 2
          ? 'moderate'
          : 'minor';
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

function buildEmergencyTranscript(
  dangers: Disaster[],
  callerName: string,
  caller: LatLng,
): string {
  const coords = `${caller.lat.toFixed(5)}, ${caller.lng.toFixed(5)}`;
  const head = [
    `This is an automated 911 report from Sentinel-City.`,
    `Caller: ${callerName}.`,
    `Location: ${coords}.`,
  ];

  // Defensive fallback — the modal shouldn't open when dangers is empty, but
  // if a caller manages it (e.g. they just exited the zone) say something
  // coherent rather than emitting "is inside zero zones".
  if (dangers.length === 0) {
    return [
      ...head,
      `Caller is requesting emergency assistance at this location.`,
      `Please dispatch the nearest available unit.`,
    ].join(' ');
  }

  // Sort worst-first so dispatch hears the most urgent zone before the others.
  const sorted = [...dangers].sort((a, b) => b.severity - a.severity);

  let situation: string;
  if (sorted.length === 1) {
    situation = `The caller is inside ${describeZone(sorted[0])}.`;
  } else {
    // Worst zone gets full English; the remainder are listed compactly so the
    // sentence still scans even with four overlapping zones. Reads like:
    // "Caller is inside a severe wildfire zone (severity 4, storm-driven),
    //  overlapping with: a moderate flood zone (severity 2); a minor accident
    //  zone (severity 1)."
    const primary = describeZone(sorted[0]);
    const rest = sorted.slice(1).map(describeZone).join('; ');
    situation = `The caller is inside ${primary}, overlapping with: ${rest}.`;
  }

  const overlapNote =
    sorted.length > 1
      ? `Multiple hazards on scene — ${sorted.length} overlapping zones — coordinate the response.`
      : null;

  return [
    ...head,
    situation,
    overlapNote,
    `Caller requires immediate assistance. Please dispatch the nearest available unit.`,
  ]
    .filter(Boolean)
    .join(' ');
}

// Which active disasters does this point sit inside? Empty = the user is in
// the clear. The disaster's geometry can be Polygon or Point; either way
// disasterRing() gives us a closed ring suitable for point-in-polygon.
function activeDangersContaining(
  loc: LatLng | null,
  disasters: Disaster[],
): Disaster[] {
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
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const avoidSignature = useRef<string>('');
  // 911 call placement state.
  //   - modalOpen drives the multi-step EmergencyCallModal (voice + selection).
  //   - placingCall: true while POST is in flight.
  //   - lastCallAt: timestamp of the last successful submission, used to
  //     debounce repeated taps for 30 s.
  const [modalOpen, setModalOpen] = useState(false);
  const [placingCall, setPlacingCall] = useState(false);
  const [lastCallAt, setLastCallAt] = useState<number | null>(null);
  // The transcript shown / spoken inside the modal. Computed once at open time
  // so it doesn't change mid-flow if disasters update between voice and submit.
  const [callTranscript, setCallTranscript] = useState<string>('');
  const [callDisasterId, setCallDisasterId] = useState<string | null>(null);

  // Pull "me" from the backend so the map reflects mock-location updates from
  // the Location screen too.
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
  const insideDangers = useMemo(
    () => activeDangersContaining(myLatLng, disasters),
    [myLatLng, disasters],
  );
  const activeCount = disasters.filter((d) => d.status === 'active').length;

  // The DisasterMap already polls disasters every 3 s and surfaces them via
  // onDisastersChange. Reroute immediately when that local set changes — saves
  // up to 2 s vs. waiting for our own poll to catch the same data.
  const lastDisasterSig = useRef<string>('');
  useEffect(() => {
    if (!destination || !myLatLng) return;
    const sig = JSON.stringify(disastersToAvoidPolygons(disasters));
    if (sig === lastDisasterSig.current) return;
    lastDisasterSig.current = sig;
    computeRoute(myLatLng, destination);
    // myLatLng intentionally omitted from deps — we only want this to fire on
    // disaster-set changes, not on every GPS poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disasters, destination]);

  const computeRoute = useCallback(
    async (from: LatLng, to: LatLng) => {
      setRouting(true);
      setRouteError(null);
      try {
        const [notifs, cordons, disastersNow] = await Promise.all([
          api.listNotifications().catch(() => [] as Notification[]),
          api.listCordons().catch(() => [] as Cordon[]),
          api.listDisasters().catch(() => [] as Disaster[]),
        ]);
        const avoid = [
          ...notifsToAvoidPolygons([...notifs, ...cordons]),
          ...disastersToAvoidPolygons(disastersNow),
        ];
        avoidSignature.current = JSON.stringify(avoid);
        const r = await fetchRoute(from, to, avoid);
        setRoute(r);
      } catch (err) {
        setRoute(null);
        setRouteError(
          err instanceof Error ? err.message : 'Could not compute a safe route right now.'
        );
      } finally {
        setRouting(false);
      }
    },
    []
  );

  // Keep latest "me" in a ref so the rerouter doesn't re-establish its timer
  // every poll cycle (myLatLng is a new object each render).
  const meRef = useRef<MobileCitizen | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  // Re-route automatically whenever the active hazard set OR active disaster
  // set changes. Polling every 2 s so a freshly-added disaster on the path
  // triggers a reroute within a couple of seconds.
  useEffect(() => {
    if (!destination) return;
    let cancelled = false;
    const tick = async () => {
      const latest = meRef.current;
      if (!latest) return;
      try {
        const [notifs, cordons, disastersNow] = await Promise.all([
          api.listNotifications().catch(() => [] as Notification[]),
          api.listCordons().catch(() => [] as Cordon[]),
          api.listDisasters().catch(() => [] as Disaster[]),
        ]);
        const sig = JSON.stringify([
          ...notifsToAvoidPolygons([...notifs, ...cordons]),
          ...disastersToAvoidPolygons(disastersNow),
        ]);
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

  // Open the 911 modal. Locks in the worst active disaster + the transcript
  // at open time so the values shown / spoken inside the modal stay stable
  // even if the disaster set updates while the citizen is choosing services.
  const openEmergencyCall = () => {
    if (!session || !myLatLng || insideDangers.length === 0) return;
    // Pass the full set of overlapping zones so the transcript can describe
    // every active hazard at the caller's position — not just the worst one.
    // The backend's placeEmergencyCall still wants a single disaster_id, so
    // we anchor it to the worst-severity zone (highest first).
    const worst = [...insideDangers].sort((a, b) => b.severity - a.severity)[0];
    const transcript = buildEmergencyTranscript(insideDangers, me?.name ?? session.name, myLatLng);
    setCallTranscript(transcript);
    setCallDisasterId(worst.id);
    setModalOpen(true);
  };

  // Fired by the modal once the citizen has picked the service(s). We POST
  // here — the modal is purely UI for voice + selection.
  const submitEmergencyCall = async (services: EmergencyService[]) => {
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
      });
      setLastCallAt(Date.now());
      setModalOpen(false);
      Alert.alert(
        '🚨 911 dispatched',
        `Notified: ${services.join(', ')}. They've been given your location and the hazard details. Stay on the line — help is on the way.`,
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

  // 30 s cooldown after a successful call so a panicked citizen doesn't spam
  // dispatch by repeated taps.
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
        destination={destination}
        route={route}
        onMapPress={onMapPress}
        onDisastersChange={setDisasters}
      />

      {insideDangers.length > 0 && (
        <View style={styles.dangerBanner}>
          <Text style={styles.dangerTitle}>
            ⚠ DANGER — you are inside an active {insideDangers[0].disaster_type.replace('_', ' ').toLowerCase()} zone
          </Text>
          <Text style={styles.dangerSub}>
            Severity {insideDangers[0].severity}
            {insideDangers.length > 1 ? ` · ${insideDangers.length - 1} more overlapping` : ''}
            {' '}· Tap the map to set a safe destination
          </Text>
        </View>
      )}

      {/* Call 911 — gated on being inside an active zone. The button is the
          only way for citizens to escalate to police, and it auto-fills the
          transcript so the caller doesn't have to compose anything. */}
      {insideDangers.length > 0 && (
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
      )}

      <EmergencyCallModal
        visible={modalOpen}
        transcript={callTranscript}
        submitting={placingCall}
        onCancel={() => setModalOpen(false)}
        onSubmit={submitEmergencyCall}
      />
      {insideDangers.length === 0 && activeCount > 0 && (
        <View style={styles.advisoryBanner}>
          <Text style={styles.advisoryText}>
            ⚠ {activeCount} active danger zone{activeCount === 1 ? '' : 's'} nearby — stay clear of red areas
          </Text>
        </View>
      )}

      <View style={styles.banner}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerTitle}>
            {destination ? 'Route set' : 'Tap the map to choose a destination'}
          </Text>
          {route && (
            <Text style={styles.bannerSub}>
              {route.distanceKm.toFixed(1)} km · ~{Math.round(route.durationMin)} min · avoiding active hazards
            </Text>
          )}
          {routing && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <ActivityIndicator color={colors.info} />
              <Text style={styles.bannerSub}>Calculating safer path…</Text>
            </View>
          )}
          {routeError && <Text style={[styles.bannerSub, { color: colors.danger }]}>{routeError}</Text>}
        </View>
        {destination && (
          <Pressable onPress={clearRoute} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  banner: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    padding: 14,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerTitle: { color: colors.textPrimary, fontWeight: '700' },
  bannerSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
  },
  clearBtnText: { color: colors.textPrimary, fontWeight: '600' },
  dangerBanner: {
    position: 'absolute',
    top: 80,
    left: 16,
    right: 16,
    backgroundColor: colors.danger,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  dangerTitle: { color: '#fff', fontWeight: '800', fontSize: 14 },
  dangerSub: { color: '#fff', opacity: 0.9, fontSize: 12, marginTop: 4 },
  advisoryBanner: {
    position: 'absolute',
    top: 80,
    left: 16,
    right: 16,
    backgroundColor: colors.warning ?? '#d97706',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  advisoryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  call911Btn: {
    position: 'absolute',
    bottom: 110, // sits above the destination/route banner at bottom: 24
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
