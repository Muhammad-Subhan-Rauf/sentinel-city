// Emergency Worker map. Tap empty road to compute a vehicle route via Valhalla;
// tap a hazard polygon to inspect the linked disaster event.

import React, { useCallback, useEffect, useState } from 'react';
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
  const out: number[][][] = [];
  for (const n of items) {
    if (n.geometry?.type !== 'Polygon') continue;
    const ring: Array<[number, number]> = n.geometry.coordinates[0] ?? [];
    if (ring.length >= 3) out.push(ring as unknown as number[][]);
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

  const computeRoute = useCallback(async (from: LatLng, to: LatLng) => {
    setRouting(true);
    setRouteError(null);
    try {
      const [notifs, cordons] = await Promise.all([
        api.listNotifications().catch(() => [] as Notification[]),
        api.listCordons().catch(() => [] as Cordon[]),
      ]);
      const avoid = notifsToAvoidPolygons([...notifs, ...cordons]);
      const r = await fetchRoute(from, to, avoid);
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
        myUserId={session.userId}
        showOtherUsers
        destination={destination}
        route={route}
        onMapPress={onMapPress}
        onPolygonPress={onPolygonPress}
      />
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
