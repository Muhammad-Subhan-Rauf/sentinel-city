// Emergency Worker map. Tap empty road to compute a vehicle route via Valhalla;
// tap a hazard polygon to inspect the linked disaster event.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { DisasterDetailModal } from '@/components/DisasterDetailModal';
import { api, fetchRoute, Cordon, Disaster, MobileWorker, Notification, Route, WorkerSubRole } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';
import { Text, Card, Button, Badge, IconBadge, Icon, BadgeTone } from '@/components/ui';
import { disasterRing, ringForValhallaAvoid } from '@/lib/geo';
import { useDispatchTarget, setDispatchTarget, scopeKeyFor } from '@/lib/dispatchTarget';

type LatLng = { lat: number; lng: number };

const NEXT_STATUS: Record<MobileWorker['status'], MobileWorker['status']> = {
  available: 'dispatched',
  dispatched: 'on_scene',
  on_scene: 'available',
  off_duty: 'available',
};

const STATUS_ACTION: Record<MobileWorker['status'], string> = {
  available: 'Mark dispatched',
  dispatched: 'Mark on scene',
  on_scene: 'Mark available',
  off_duty: 'Go on duty',
};

const STATUS_TONE: Record<MobileWorker['status'], BadgeTone> = {
  available: 'success',
  dispatched: 'warning',
  on_scene: 'info',
  off_duty: 'neutral',
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

export default function WorkerMapScreen() {
  const t = useTheme();
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

  const lastAvoidSig = useRef<string>('');

  const computeRoute = useCallback(async (from: LatLng, to: LatLng) => {
    setRouting(true);
    setRouteError(null);
    try {
      const [notifs, cordons, disasters] = await Promise.all([
        api.listNotifications().catch(() => [] as Notification[]),
        api.listCordons().catch(() => [] as Cordon[]),
        // Only avoid disasters citizens have reported (same set the map shows).
        api.listReportedDisasters().catch(() => [] as Disaster[]),
      ]);
      const avoid = [...notifsToAvoidPolygons([...notifs, ...cordons]), ...disastersToAvoidPolygons(disasters)];
      lastAvoidSig.current = JSON.stringify(avoid);
      const r = await fetchRoute(from, to, avoid, 'auto');
      setRoute(r);
    } catch (err) {
      setRoute(null);
      setRouteError(err instanceof Error ? err.message : 'Could not compute a route right now.');
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

  useEffect(() => {
    if (!dispatchTarget || !me) return;
    const dest = { lat: dispatchTarget.lat, lng: dispatchTarget.lng };
    setDestination(dest);
    computeRoute({ lat: me.lat, lng: me.lng }, dest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchTarget?.callId, !!me]);

  useEffect(() => {
    if (!destination || !me) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [notifs, cordons, disasters] = await Promise.all([
          api.listNotifications().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Notification[]),
          api.listCordons().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => [] as Cordon[]),
          api.listReportedDisasters().catch(() => [] as Disaster[]),
        ]);
        if (cancelled) return;
        const sig = JSON.stringify([...notifsToAvoidPolygons([...notifs, ...cordons]), ...disastersToAvoidPolygons(disasters)]);
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
    setDispatchTarget(dispatchScope, null);
    setDestination(null);
    setRoute(null);
    setRouteError(null);
  };

  if (!session) return null;
  const myLoc = me ? { lat: me.lat, lng: me.lng } : null;
  const subRoleLabel = me ? SUB_ROLE_LABEL[me.role] ?? me.role : '';
  const accent =
    me?.role === 'firefighter' ? t.color.firefighter : me?.role === 'police' ? t.color.police : t.color.paramedic;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
      <DisasterMap
        myLocation={myLoc}
        myRole="worker"
        mySubRole={me?.role ?? session.sub_role}
        myUserId={session.userId}
        showOtherUsers
        destination={destination}
        route={route}
        onMapPress={onMapPress}
        onPolygonPress={onPolygonPress}
      />

      {dispatchTarget && (
        <View style={[styles.dispatchBanner, { backgroundColor: t.color.danger, borderRadius: t.radius.lg, ...t.shadow(2) }]} accessibilityRole="alert">
          <Icon name="route" size={20} color={t.color.onDanger} />
          <View style={{ flex: 1, marginLeft: t.spacing.md }}>
            <Text variant="h3" color={t.color.onDanger}>
              Dispatched to caller
            </Text>
            <Text variant="caption" color={t.color.onDanger} style={{ opacity: 0.92, marginTop: 1 }} numberOfLines={2}>
              {dispatchTarget.label}
            </Text>
          </View>
        </View>
      )}

      <Card style={styles.banner} elevation={2}>
        <IconBadge
          name={me?.role === 'firefighter' ? 'firefighter' : me?.role === 'police' ? 'police' : 'ambulance'}
          color={accent}
          size={44}
        />
        <View style={{ flex: 1, marginHorizontal: t.spacing.md }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {me?.name ?? 'Loading…'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <Text variant="caption" tone="secondary">
              {subRoleLabel}
            </Text>
            {me && <Badge label={me.status.replace('_', ' ')} tone={STATUS_TONE[me.status]} />}
          </View>
          {destination && route && !routing && (
            <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
              {route.distanceKm.toFixed(1)} km · ~{Math.round(route.durationMin)} min
            </Text>
          )}
          {routing && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <ActivityIndicator color={t.color.primary} size="small" />
              <Text variant="caption" tone="secondary">
                Computing route…
              </Text>
            </View>
          )}
          {routeError && (
            <Text variant="caption" tone="danger" style={{ marginTop: 4 }}>
              {routeError}
            </Text>
          )}
        </View>
        {destination ? (
          <Button label="Clear" variant="secondary" size="sm" fullWidth={false} onPress={clearRoute} />
        ) : (
          <Pressable
            onPress={cycleStatus}
            accessibilityRole="button"
            accessibilityLabel={me ? STATUS_ACTION[me.status] : 'Update status'}
            style={({ pressed }) => [styles.statusBtn, { backgroundColor: accent, borderRadius: t.radius.md, opacity: pressed ? 0.85 : 1 }]}
          >
            <Icon name="refresh" size={15} color={t.color.alwaysWhite} />
            <Text variant="label" color={t.color.alwaysWhite}>
              {me ? STATUS_ACTION[me.status] : 'Status'}
            </Text>
          </Pressable>
        )}
      </Card>

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
    top: 64,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  banner: { position: 'absolute', bottom: 24, left: 16, right: 16, flexDirection: 'row', alignItems: 'center' },
  statusBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 11, minHeight: 44 },
});
