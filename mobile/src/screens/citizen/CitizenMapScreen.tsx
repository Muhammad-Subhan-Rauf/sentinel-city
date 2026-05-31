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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DisasterMap } from '@/components/DisasterMap';
import { DestinationSearch } from '@/components/DestinationSearch';
import { NavBanner } from '@/components/NavBanner';
import { DisasterDetailModal } from '@/components/DisasterDetailModal';
import { api, fetchRoute, MobileCitizen, Notification, Cordon, Route, Disaster } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Button, Icon } from '@/components/ui';
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
  const [navigating, setNavigating] = useState(false);
  const avoidSignature = useRef<string>('');

  // Tap-a-zone detail sheet.
  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneDisaster, setZoneDisaster] = useState<Disaster | null>(null);
  const [zoneFallback, setZoneFallback] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);

  // One-time hint: "tap the map to set a destination" shows until the user sets
  // their first destination, then is hidden for good so it stops eating space.
  const ROUTED_KEY = 'sentinel.routed-hint.v1';
  const [routedBefore, setRoutedBefore] = useState(true); // assume seen until storage loads (avoids a flash)
  useEffect(() => {
    AsyncStorage.getItem(ROUTED_KEY).then((v) => setRoutedBefore(v === '1')).catch(() => setRoutedBefore(true));
  }, []);
  const markRouted = useCallback(() => {
    setRoutedBefore(true);
    AsyncStorage.setItem(ROUTED_KEY, '1').catch(() => {});
  }, []);

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

  // The top search bar grows to a taller two-line "Destination" bar once a
  // destination is set, so drop the hazard banner below it to avoid an overlap.
  const bannerTop = insets.top + (destination ? 100 : 72);

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
    const handle = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [destination, computeRoute]);

  const onMapPress = (lat: number, lng: number) => {
    if (!myLatLng) return;
    const dest = { lat, lng };
    setDestination(dest);
    markRouted();
    computeRoute(myLatLng, dest);
  };

  // Picked from the destination search box. Same effect as tapping the map.
  const onSearchSelect = (p: { lat: number; lng: number }) => {
    const dest = { lat: p.lat, lng: p.lng };
    setDestination(dest);
    markRouted();
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
    setNavigating(false);
  };

  // Tap a hazard zone → show what it is, how severe, and any details.
  const onPolygonPress = async (eventId: string | null, label: string) => {
    setZoneModalOpen(true);
    setZoneDisaster(null);
    setZoneFallback(label);
    setZoneError(null);
    if (!eventId) {
      setZoneLoading(false);
      return;
    }
    setZoneLoading(true);
    try {
      setZoneDisaster(await api.getDisaster(eventId));
    } catch (err) {
      setZoneError(err instanceof Error ? err.message : 'Could not load zone details.');
    } finally {
      setZoneLoading(false);
    }
  };

  if (!session) return null;

  const worstSeverity = insideDangers.length ? Math.max(...insideDangers.map((d) => d.severity)) : 0;

  // Lift the bottom-right legend only as much as the current bottom content
  // needs: the full route panel (~88), the one-time hint pill (~56), or nothing
  // (0) so the chip sits near the bottom instead of floating in mid-air.
  const routePanelUp = !!(destination || routing || routeError);
  const legendClearance = routePanelUp ? 88 : !routedBefore ? 56 : 0;

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
        onPolygonPress={onPolygonPress}
        onDisastersChange={setDisasters}
        legendBottom={legendClearance}
        navMode={navigating}
      />

      {/* Destination search — pinned to the top, above the hazard banners.
          Higher z-index so the autocomplete dropdown overlays everything.
          Hidden during turn-by-turn so the nav banner owns the screen. */}
      {!navigating && (
        <View style={[styles.searchWrap, { top: insets.top + 8, zIndex: 30 }]}>
          <DestinationSearch focus={myLatLng} destination={destination} onSelect={onSearchSelect} onClear={clearRoute} />
        </View>
      )}

      {/* In-zone DANGER banner */}
      {!navigating && insideDangers.length > 0 && (
        <View
          style={[styles.topBanner, { top: bannerTop, backgroundColor: t.color.danger, borderRadius: t.radius.lg, ...t.shadow(2) }]}
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
      {!navigating && insideDangers.length === 0 && activeCount > 0 && (
        <View style={[styles.topBanner, { top: bannerTop, backgroundColor: t.color.warning, borderRadius: t.radius.lg, ...t.shadow(2) }]}>
          <Icon name="alert" size={20} color={t.color.alwaysWhite} />
          <Text variant="bodyStrong" color={t.color.alwaysWhite} style={{ flex: 1, marginLeft: t.spacing.md }}>
            {activeCount} active danger zone{activeCount === 1 ? '' : 's'} nearby — stay clear of red areas
          </Text>
        </View>
      )}

      {/* When inside a zone, the centre SOS button in the tab bar pulses red
          (see CitizenTabBar + dangerSignal) — no extra button is drawn here. */}

      {/* Route panel — shown only while a route is active. The "tap to set a
          destination" hint shows once (until the first route is set) then is
          hidden for good, so it doesn't permanently eat the bottom of the map. */}
      {!navigating && (destination || routing || routeError) ? (
        <Card style={styles.routePanel} elevation={2}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="route" size={16} color={t.color.primary} />
              <Text variant="bodyStrong" style={{ flex: 1 }}>
                Safe route set
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
          {route && !routing ? (
            <Button label="Start" variant="primary" size="sm" icon="play" fullWidth={false} onPress={() => setNavigating(true)} />
          ) : null}
        </Card>
      ) : !routedBefore ? (
        <View style={[styles.hintWrap, { bottom: insets.bottom + 24 }]} pointerEvents="none">
          <View style={[styles.hintPill, { backgroundColor: t.color.surface, borderColor: t.color.border, borderRadius: t.radius.pill, ...t.shadow(1) }]}>
            <Icon name="location" size={14} color={t.color.primary} />
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              Tap the map or search to set a destination
            </Text>
          </View>
        </View>
      ) : null}

      {/* Turn-by-turn navigation overlay (zooms + follows via navMode above). */}
      {navigating && route ? (
        <NavBanner route={route} location={myLatLng} onEnd={() => setNavigating(false)} />
      ) : null}

      <DisasterDetailModal
        visible={zoneModalOpen}
        loading={zoneLoading}
        disaster={zoneDisaster}
        fallbackLabel={zoneFallback}
        error={zoneError}
        onClose={() => setZoneModalOpen(false)}
      />
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
  hintWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  hintPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, maxWidth: '90%' },
});
