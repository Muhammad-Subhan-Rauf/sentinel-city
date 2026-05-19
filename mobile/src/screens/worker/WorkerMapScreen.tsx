// Emergency Worker map. Same map component as Citizen, but with
// showOtherUsers=true so the worker can see citizens and other responders.

import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import { DisasterMap } from '@/components/DisasterMap';
import { api, MobileWorker } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';

const NEXT_STATUS: Record<MobileWorker['status'], MobileWorker['status']> = {
  available: 'dispatched',
  dispatched: 'on_scene',
  on_scene: 'available',
  off_duty: 'available',
};

export default function WorkerMapScreen() {
  const { session } = useAuth();
  const [me, setMe] = useState<MobileWorker | null>(null);

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

  if (!session) return null;
  const myLoc = me ? { lat: me.lat, lng: me.lng } : null;

  return (
    <View style={styles.container}>
      <DisasterMap
        myLocation={myLoc}
        myRole="worker"
        myUserId={session.userId}
        showOtherUsers
      />
      <View style={styles.banner}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerTitle}>{me?.name ?? 'Loading…'}</Text>
          <Text style={styles.bannerSub}>
            {me ? `${me.role} · status: ${me.status.replace('_', ' ')}` : ' '}
          </Text>
        </View>
        <Pressable onPress={cycleStatus} style={styles.statusBtn}>
          <Text style={styles.statusBtnText}>Next status</Text>
        </Pressable>
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
  bannerSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
  statusBtn: {
    backgroundColor: colors.worker,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  statusBtnText: { color: '#fff', fontWeight: '700' },
});
