// Shared by Citizen + Worker. Pulls active notifications and cordons from the
// backend, computes distance from the user, and only shows alerts within
// 20 km. Refreshes every 5 s.

import React, { useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import {
  api,
  MobileCitizen,
  MobileWorker,
  Notification,
  Cordon,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/colors';
import { geometryCentroid, haversineMeters, KM_20_M } from '@/lib/geo';

type AlertItem = {
  id: string;
  kind: 'notification' | 'cordon';
  reason: string;
  distanceM: number;
  createdAt: string;
};

async function fetchMe(role: 'citizen' | 'worker', id: string): Promise<MobileCitizen | MobileWorker | null> {
  try {
    return role === 'citizen' ? await api.getCitizen(id) : await api.getWorker(id);
  } catch {
    return null;
  }
}

export default function NotificationsScreen() {
  const { session } = useAuth();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tooFarCount, setTooFarCount] = useState(0);

  const load = async () => {
    if (!session || session.role === 'admin') return;
    setRefreshing(true);
    try {
      const me = await fetchMe(session.role, session.userId);
      if (!me) {
        setAlerts([]);
        return;
      }
      const [notifs, cordons] = await Promise.all([
        api.listNotifications().catch(() => [] as Notification[]),
        api.listCordons().catch(() => [] as Cordon[]),
      ]);
      const combined: AlertItem[] = [];
      let far = 0;
      const consider = (
        list: Array<Notification | Cordon>,
        kind: 'notification' | 'cordon'
      ) => {
        for (const item of list) {
          const center = geometryCentroid(item.geometry);
          if (!center) continue;
          const d = haversineMeters({ lat: me.lat, lng: me.lng }, center);
          if (d <= KM_20_M) {
            combined.push({
              id: `${kind}-${item.id}`,
              kind,
              reason: item.reason ?? (kind === 'cordon' ? 'Cordoned area' : 'Alert'),
              distanceM: d,
              createdAt: item.created_at,
            });
          } else {
            far++;
          }
        }
      };
      consider(notifs, 'notification');
      consider(cordons, 'cordon');
      combined.sort((a, b) => a.distanceM - b.distanceM);
      setAlerts(combined);
      setTooFarCount(far);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const handle = setInterval(load, 5000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId]);

  return (
    <Screen title="Notifications" scroll={false}>
      <Text style={styles.subtitle}>
        Alerts within 20 km of your current location.
      </Text>
      <FlatList
        data={alerts}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.info} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No alerts nearby. You're in the clear.</Text>
            {tooFarCount > 0 && (
              <Text style={styles.emptyMuted}>
                {tooFarCount} active alert{tooFarCount === 1 ? '' : 's'} elsewhere in the city.
              </Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={[
              styles.card,
              {
                borderLeftColor: item.kind === 'cordon' ? colors.warning : colors.danger,
              },
            ]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardKind}>
                {item.kind === 'cordon' ? '🚧 Cordon' : '🚨 Evacuation Alert'}
              </Text>
              <Text style={styles.cardDistance}>
                {item.distanceM < 1000
                  ? `${Math.round(item.distanceM)} m`
                  : `${(item.distanceM / 1000).toFixed(1)} km`}
              </Text>
            </View>
            <Text style={styles.cardReason}>{item.reason}</Text>
            <Text style={styles.cardTime}>{new Date(item.createdAt).toLocaleTimeString()}</Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { color: colors.textSecondary, marginBottom: 12 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  cardKind: { color: colors.textPrimary, fontWeight: '700' },
  cardDistance: { color: colors.info, fontWeight: '600' },
  cardReason: { color: colors.textPrimary, fontSize: 14, marginBottom: 6 },
  cardTime: { color: colors.textMuted, fontSize: 11 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  emptyMuted: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
});
