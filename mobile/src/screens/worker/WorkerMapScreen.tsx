// Emergency Worker map. The worker sees:
//   - their own location (sub-role-colored marker)
//   - AI-issued alert / cordon zones (rendered by DisasterMap)
//   - their assigned dispatch target (delivered by /api/me/dispatch) along
//     with the AI's pre-computed avoidance-aware route polyline
//
// This screen does NOT decide which calls to respond to. It does not compute
// routes. It does not poll /api/disasters. All dispatch decisions arrive from
// the backend AI agent — the mobile app just renders the command.

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { DisasterDetailModal } from '@/components/DisasterDetailModal';
import {
  api,
  Disaster,
  DispatchOrder,
  MobileWorker,
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

export default function WorkerMapScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileWorker | null>(null);
  const [order, setOrder] = useState<DispatchOrder | null>(null);
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

  // Poll the per-worker dispatch feed. The AI issues dispatches via
  // dispatch_units; the backend assigns one to this worker and computes the
  // route. We render whatever's in the slot — no client-side decisions.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getMyDispatch(session.userId);
        if (!cancelled) setOrder(fresh);
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

  const completeDispatch = async () => {
    if (!session) return;
    try {
      await api.clearMyDispatch(session.userId);
      setOrder(null);
    } catch {
      /* keep last */
    }
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

  if (!session) return null;
  const myLoc: LatLng | null = me ? { lat: me.lat, lng: me.lng } : null;
  const subRoleLabel = me ? SUB_ROLE_LABEL[me.role] ?? me.role : '';
  const destination: LatLng | null = order
    ? { lat: order.target.lat, lng: order.target.lng }
    : null;

  return (
    <View style={styles.container}>
      <DisasterMap
        myLocation={myLoc}
        myRole="worker"
        mySubRole={me?.role ?? session.sub_role}
        myUserId={session.userId}
        showOtherUsers
        showRawDisasters={false}
        destination={destination}
        route={order?.route ?? null}
        onPolygonPress={onPolygonPress}
      />

      {order && (
        <View style={styles.dispatchBanner}>
          <Text style={styles.dispatchTitle}>🚨 Sentinel dispatch</Text>
          <Text style={styles.dispatchSub}>
            {order.units} {order.kind}
            {order.units === 1 ? '' : 's'} → {order.target.lat.toFixed(4)},{' '}
            {order.target.lng.toFixed(4)}
          </Text>
          {order.route && (
            <Text style={styles.dispatchSub}>
              Route: {order.route.distanceKm.toFixed(1)} km · ~
              {Math.round(order.route.durationMin)} min
            </Text>
          )}
        </View>
      )}

      <View style={styles.banner}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerTitle}>{me?.name ?? 'Loading…'}</Text>
          <Text style={styles.bannerSub}>
            {me ? `${subRoleLabel} · status: ${me.status.replace('_', ' ')}` : ' '}
          </Text>
        </View>
        {order ? (
          <Pressable onPress={completeDispatch} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Complete</Text>
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
