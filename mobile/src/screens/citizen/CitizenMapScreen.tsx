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
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { api, fetchRoute, MobileCitizen, Notification, Cordon, Route } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';

type LatLng = { lat: number; lng: number };

function notifsToAvoidPolygons(notifs: Array<Notification | Cordon>): number[][][] {
  // Valhalla wants [[[lng, lat], ...]] per polygon. Convert from GeoJSON.
  const out: number[][][] = [];
  for (const n of notifs) {
    if (n.geometry?.type !== 'Polygon') continue;
    const ring: Array<[number, number]> = n.geometry.coordinates[0] ?? [];
    if (ring.length >= 3) out.push(ring as unknown as number[][]);
  }
  return out;
}

export default function CitizenMapScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileCitizen | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const avoidSignature = useRef<string>('');

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

  const computeRoute = useCallback(
    async (from: LatLng, to: LatLng) => {
      setRouting(true);
      setRouteError(null);
      try {
        const [notifs, cordons] = await Promise.all([
          api.listNotifications().catch(() => [] as Notification[]),
          api.listCordons().catch(() => [] as Cordon[]),
        ]);
        const avoid = notifsToAvoidPolygons([...notifs, ...cordons]);
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

  // Re-route automatically whenever the active hazard set changes.
  useEffect(() => {
    if (!destination) return;
    let cancelled = false;
    const tick = async () => {
      const latest = meRef.current;
      if (!latest) return;
      try {
        const [notifs, cordons] = await Promise.all([
          api.listNotifications().catch(() => [] as Notification[]),
          api.listCordons().catch(() => [] as Cordon[]),
        ]);
        const sig = JSON.stringify(notifsToAvoidPolygons([...notifs, ...cordons]));
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
    computeRoute(myLatLng, dest);
  };

  const clearRoute = () => {
    setDestination(null);
    setRoute(null);
    setRouteError(null);
  };

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
      />

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
});
