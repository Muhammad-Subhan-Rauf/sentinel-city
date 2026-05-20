// Emergency Worker map. Tap empty road to compute a vehicle route via Valhalla;
// tap a hazard polygon to inspect the linked disaster event.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { DisasterDetailModal } from '@/components/DisasterDetailModal';
import {
  api,
  fetchRoute,
  Cordon,
  Disaster,
  MobileWorker,
  Notification,
  Route,
  WorkerSubRole,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { disasterRing, ringForValhallaAvoid } from '@/lib/geo';
import { useDispatchTarget, setDispatchTarget, scopeKeyFor } from '@/lib/dispatchTarget';

type LatLng = { lat: number; lng: number };

const NEXT_STATUS: Record<MobileWorker['status'], MobileWorker['status']> = {
  available: 'dispatched',
  dispatched: 'on_scene',
  on_scene: 'available',
  off_duty: 'available',
};

const SUB_ROLE_LABEL: Record<WorkerSubRole, string> = {
  firefighter: 'Firefighter',
  paramedic: 'Paramedic / EMS',
  police: 'Police',
};

function notifsToAvoidPolygons(items: Array<Notification | Cordon>): number[][][] {
  // Shrink oversized rings to a Valhalla-safe perimeter (10 km cap).
  const out: number[][][] = [];
  for (const n of items) {
    if (n.geometry?.type !== 'Polygon') continue;
    const raw: Array<[number, number]> = n.geometry.coordinates[0] ?? [];
    const safe = ringForValhallaAvoid(raw);
    if (safe.length >= 3) out.push(safe as unknown as number[][]);
  }
  return out;
}

// Active disaster footprints. Point disasters become a severity-scaled circle;
// oversized polygons get down-sampled to a Valhalla-safe circumference. Same
// shape the citizen route uses — workers should not drive into a live hazard.
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

export default function WorkerMapScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileWorker | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalDisaster, setModalDisaster] = useState<Disaster | null>(null);
  const [modalFallback, setModalFallback] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Pub-sub from the Calls tab: when this worker acknowledges a 911 call,
  // that screen pushes a DispatchTarget under our (device + sub_role) scope.
  // Each worker sub-role on the same device has its own slot, so a
  // firefighter's dispatch doesn't follow them into a police session.
  const dispatchScope = scopeKeyFor(session?.userId, session?.sub_role);
  const dispatchTarget = useDispatchTarget(dispatchScope);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getWorker(session.userId);
        if (!cancelled) setMe(fresh);
      } catch {
        /* ignore */
      }
    };
    tick();
    const handle = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [session]);

  const cycleStatus = async () => {
    if (!session || !me) return;
    const next = NEXT_STATUS[me.status];
    try {
      const updated = await api.updateWorker(session.userId, { status: next });
      setMe(updated);
    } catch {
      /* surface inline later */
    }
  };

  // Latest disasters cached here so the dispatch-change re-route effect can
  // detect when the hazard set shifts. Filled by computeRoute.
  const lastAvoidSig = useRef<string>('');

  const computeRoute = useCallback(async (from: LatLng, to: LatLng) => {
    setRouting(true);
    setRouteError(null);
    try {
      // Pull every hazard surface the responder shouldn't drive through:
      // operator-drawn evac polygons, no-entry cordons, AND the actual
      // active disaster footprints. Engulfing polygons (start/end inside)
      // are stripped server-side by fetchRoute so a responder whose station
      // is *inside* a zone can still leave.
      const [notifs, cordons, disasters] = await Promise.all([
        api.listNotifications().catch(() => [] as Notification[]),
        api.listCordons().catch(() => [] as Cordon[]),
        api.listDisasters().catch(() => [] as Disaster[]),
      ]);
      const avoid = [
        ...notifsToAvoidPolygons([...notifs, ...cordons]),
        ...disastersToAvoidPolygons(disasters),
      ];
      lastAvoidSig.current = JSON.stringify(avoid);
      // Workers drive emergency vehicles → fastest road route that avoids
      // every active hazard. Valhalla returns the shortest-time path through
      // the *remaining* road graph, so it's both quick and safe.
      const r = await fetchRoute(from, to, avoid, 'auto');
      setRoute(r);
    } catch (err) {
      setRoute(null);
      setRouteError(
        err instanceof Error ? err.message : 'Could not compute a route right now.'
      );
    } finally {
      setRouting(false);
    }
  }, []);

  const onMapPress = (lat: number, lng: number) => {
    if (!me) return;
    const dest = { lat, lng };
    setDestination(dest);
    computeRoute({ lat: me.lat, lng: me.lng }, dest);
  };

  // When the Calls tab pushes a new dispatch target, latch it as the
  // destination and compute a route from the worker's current position.
  // Cleared when the worker explicitly hits "Clear" or marks the call closed.
  useEffect(() => {
    if (!dispatchTarget || !me) return;
    const dest = { lat: dispatchTarget.lat, lng: dispatchTarget.lng };
    setDestination(dest);
    computeRoute({ lat: me.lat, lng: me.lng }, dest);
    // We intentionally don't recompute every time `me` changes — that would
    // burn API calls on every GPS poll. The live-reroute effect below polls
    // every 4 s and only refires when the *hazard* set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchTarget?.callId, !!me]);

  // Live reroute: while a dispatch is active, poll the hazard set every 4 s.
  // If a new disaster appears on (or a previous one disappears from) the
  // responder's path, recompute the route. Skipped when there's no dispatch
  // so off-duty workers don't burn cycles.
  useEffect(() => {
    if (!destination || !me) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [notifs, cordons, disasters] = await Promise.all([
          api.listNotifications().catch(() => [] as Notification[]),
          api.listCordons().catch(() => [] as Cordon[]),
          api.listDisasters().catch(() => [] as Disaster[]),
        ]);
        if (cancelled) return;
        const sig = JSON.stringify([
          ...notifsToAvoidPolygons([...notifs, ...cordons]),
          ...disastersToAvoidPolygons(disasters),
        ]);
        if (sig !== lastAvoidSig.current) {
          computeRoute({ lat: me.lat, lng: me.lng }, destination);
        }
      } catch {
        /* ignore — next tick will retry */
      }
    };
    const handle = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // Position changes (me.lat/lng on GPS poll) intentionally don't restart
    // the interval — we only react to hazard-set changes. The destination
    // is stable per-dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng, computeRoute]);

  const onPolygonPress = async (eventId: string | null, label: string) => {
    setModalOpen(true);
    setModalDisaster(null);
    setModalFallback(label);
    setModalError(null);
    if (!eventId) {
      setModalLoading(false);
      return;
    }
    setModalLoading(true);
    try {
      const d = await api.getDisaster(eventId);
      setModalDisaster(d);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Could not load event.');
    } finally {
      setModalLoading(false);
    }
  };

  const clearRoute = () => {
    // Drop the dispatch latch too — otherwise the useEffect above would
    // re-set the destination on the next render. Scoped to this worker only.
    setDispatchTarget(dispatchScope, null);
    setDestination(null);
    setRoute(null);
    setRouteError(null);
  };

  if (!session) return null;
  const myLoc = me ? { lat: me.lat, lng: me.lng } : null;
  const subRoleLabel = me ? SUB_ROLE_LABEL[me.role] ?? me.role : '';

  return (
    <View style={styles.container}>
      <DisasterMap
        myLocation={myLoc}
        myRole="worker"
        // me.role is the sub-role (firefighter/paramedic/police). Falling back
        // to session.sub_role keeps the dot colored correctly on the first
        // render before the /workers/<id> fetch resolves.
        mySubRole={me?.role ?? session.sub_role}
        myUserId={session.userId}
        showOtherUsers
        destination={destination}
        route={route}
        onMapPress={onMapPress}
        onPolygonPress={onPolygonPress}
      />

      {dispatchTarget && (
        <View style={styles.dispatchBanner}>
          <Text style={styles.dispatchTitle}>🚨 Dispatched to caller</Text>
          <Text style={styles.dispatchSub}>{dispatchTarget.label}</Text>
        </View>
      )}

      <View style={styles.banner}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerTitle}>{me?.name ?? 'Loading…'}</Text>
          <Text style={styles.bannerSub}>
            {me ? `${subRoleLabel} · status: ${me.status.replace('_', ' ')}` : ' '}
          </Text>
          {destination && route && (
            <Text style={styles.bannerSub}>
              Routed: {route.distanceKm.toFixed(1)} km · ~{Math.round(route.durationMin)} min
            </Text>
          )}
          {routing && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <ActivityIndicator color={colors.info} />
              <Text style={styles.bannerSub}>Computing route…</Text>
            </View>
          )}
          {routeError && <Text style={[styles.bannerSub, { color: colors.danger }]}>{routeError}</Text>}
        </View>
        {destination ? (
          <Pressable onPress={clearRoute} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        ) : (
          <Pressable onPress={cycleStatus} style={styles.statusBtn}>
            <Text style={styles.statusBtnText}>Next status</Text>
          </Pressable>
        )}
      </View>

      <DisasterDetailModal
        visible={modalOpen}
        loading={modalLoading}
        disaster={modalDisaster}
        fallbackLabel={modalFallback}
        error={modalError}
        onClose={() => setModalOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dispatchBanner: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    backgroundColor: '#dc2626',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 6,
    elevation: 4,
  },
  dispatchTitle: { color: '#fff', fontWeight: '800', fontSize: 14 },
  dispatchSub: { color: '#fff', opacity: 0.9, fontSize: 12, marginTop: 3 },
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
  statusBtn: {
    backgroundColor: colors.worker,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  statusBtnText: { color: '#fff', fontWeight: '700' },
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
