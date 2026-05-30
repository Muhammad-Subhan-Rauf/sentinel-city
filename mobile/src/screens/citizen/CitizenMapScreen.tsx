// Citizen map — Google Maps style. The user sees their own location, active
// hazards (red/yellow polygons), and a tappable destination + a route that
// avoids active hazard polygons (recomputed via Valhalla avoid_polygons).
//
// When the citizen is standing inside an active zone we DO NOT add a second
// 911 button on top of the map — we signal the tab bar so the existing
// centre SOS button pulses red. One consistent affordance, no surprise UI.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DisasterMap } from '@/components/DisasterMap';
import { DestinationSearch } from '@/components/DestinationSearch';
import { api, fetchRoute, MobileCitizen, Notification, Cordon, Route, Disaster } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Icon } from '@/components/ui';
import { disasterRing, pointInPolygon, ringForValhallaAvoid } from '@/lib/geo';
import { setInDangerZone } from '@/lib/dangerSignal';

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
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const avoidSignature = useRef<string>('');

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

  // Announce hazard entry for screen-reader users (once per entry) and signal
  // the tab bar so the centre SOS button pulses.
  const wasInDanger = useRef(false);
  useEffect(() => {
    const now = insideDangers.length > 0;
    setInDangerZone(now);
    if (now && !wasInDanger.current) {
      AccessibilityInfo.announceForAccessibility(
        `Warning. You are inside an active ${insideDangers[0].disaster_type.replace(/_/g, ' ')} zone. The SOS button is highlighted — tap it to call for help.`,
      );
    }
    wasInDanger.current = now;
  }, [insideDangers]);

  // Drop the signal if this screen unmounts (e.g. sign-out) so a stale "in
  // zone" indicator can never linger on the tab bar.
  useEffect(() => () => setInDangerZone(false), []);

  const lastDisasterSig = useRef<string>('');
  useEffect(() => {
    if (!destination || !myLatLng) return;
    const sig = JSON.stringify(disastersToAvoidPolygons(disasters));
    if (sig === lastDisasterSig.current) return;
    lastDisasterSig.current = sig;
    computeRoute(myLatLng, destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disasters, destination]);

  // Monotonic token guarding against stale async route results. Each compute
  // captures the current token; clearRoute (and every new compute) bumps it, so
  // a fetch that resolves AFTER the user cleared — or after a newer request
  // started — is discarded instead of redrawing a path that should be gone.
  const routeToken = useRef(0);

  const computeRoute = useCallback(async (from: LatLng, to: LatLng) => {
    const myToken = ++routeToken.current;
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
      if (routeToken.current !== myToken) return; // superseded by a newer request or cleared
      setRoute(r);
    } catch (err) {
      if (routeToken.current !== myToken) return;
      setRoute(null);
      setRouteError(err instanceof Error ? err.message : 'Could not compute a safe route right now.');
    } finally {
      if (routeToken.current === myToken) setRouting(false);
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

  // Picked from the destination search box. Same effect as tapping the map.
  const onSearchSelect = (p: { lat: number; lng: number }) => {
    const dest = { lat: p.lat, lng: p.lng };
    setDestination(dest);
    if (myLatLng) computeRoute(myLatLng, dest);
  };

  const clearRoute = () => {
    // Invalidate any in-flight / scheduled route compute so a late-resolving
    // fetchRoute can't repaint the path after the user cleared it.
    routeToken.current++;
    setDestination(null);
    setRoute(null);
    setRouteError(null);
    setRouting(false);
  };

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
        legendTop={insets.top + 128}
      />

      {/* Destination search — pinned to the top, above the hazard banners.
          Higher z-index so the autocomplete dropdown overlays everything. */}
      <View style={[styles.searchWrap, { top: insets.top + 8, zIndex: 30 }]}>
        <DestinationSearch focus={myLatLng} destination={destination} onSelect={onSearchSelect} onClear={clearRoute} />
      </View>

      {/* In-zone DANGER banner */}
      {insideDangers.length > 0 && (
        <View
          style={[styles.topBanner, { top: insets.top + 72, backgroundColor: t.color.danger, borderRadius: t.radius.lg, ...t.shadow(2) }]}
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
        <View style={[styles.topBanner, { top: insets.top + 72, backgroundColor: t.color.warning, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
          <Icon name="alert" size={20} color={t.color.alwaysWhite} />
          <Text variant="bodyStrong" color={t.color.alwaysWhite} style={{ flex: 1, marginLeft: t.spacing.md }}>
            {activeCount} active danger zone{activeCount === 1 ? '' : 's'} nearby — stay clear of red areas
          </Text>
        </View>
      )}

      {/* When inside a zone, the centre SOS button in the tab bar pulses red
          (see CitizenTabBar + dangerSignal) — no extra button is drawn here. */}

      {/* Destination / route panel */}
      <Card style={styles.routePanel} elevation={2}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={destination ? 'route' : 'location'} size={16} color={t.color.primary} />
            <Text variant="bodyStrong" style={{ flex: 1 }}>
              {destination ? 'Safe route set' : 'Search above or tap the map to set a destination'}
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
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
  },
  topBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
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
