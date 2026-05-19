// Shared map view used by Citizen and Worker screens. Renders:
//   - "me" marker (large, pulsing, role-coloured ring) so the user can find self
//   - other mobile users (citizens only visible to workers/admin, not to citizens)
//   - active disasters as coloured polygons / circles
//   - active notifications & cordons as warning polygons
//   - optional route polyline (citizen rerouting)

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import MapView, { Marker, Polygon, Polyline, Circle, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { api, MobileCitizen, MobileWorker, Notification, Cordon, Route } from '@/lib/api';
import { colors, roleAccent } from '@/lib/colors';

const MANHATTAN: Region = {
  latitude: 40.758,
  longitude: -73.9855,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

type Props = {
  myLocation: { lat: number; lng: number } | null;
  myRole: 'citizen' | 'worker';
  myUserId: string;
  // When true (worker mode), other citizens & workers are drawn.
  // When false (citizen mode), no other users are drawn — Google-Maps style.
  showOtherUsers: boolean;
  // Optional destination + route to draw.
  destination?: { lat: number; lng: number } | null;
  route?: Route | null;
  onMapPress?: (lat: number, lng: number) => void;
};

function polygonToCoords(geometry: any): Array<{ latitude: number; longitude: number }> {
  if (!geometry || geometry.type !== 'Polygon') return [];
  const ring: Array<[number, number]> = geometry.coordinates[0] ?? [];
  return ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

export function DisasterMap({
  myLocation,
  myRole,
  myUserId,
  showOtherUsers,
  destination,
  route,
  onMapPress,
}: Props) {
  // Live data — polled every 3 s to match the web app's cadence.
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [cordons, setCordons] = useState<Cordon[]>([]);
  const [citizens, setCitizens] = useState<MobileCitizen[]>([]);
  const [workers, setWorkers] = useState<MobileWorker[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [notifs, cordons, citizens, workers] = await Promise.all([
          api.listNotifications().catch(() => []),
          api.listCordons().catch(() => []),
          showOtherUsers ? api.listCitizens().catch(() => []) : Promise.resolve([]),
          api.listWorkers().catch(() => []),
        ]);
        if (cancelled) return;
        setNotifs(notifs);
        setCordons(cordons);
        setCitizens(citizens);
        setWorkers(workers);
      } catch {
        // Best-effort; skip frame on error.
      }
    };
    tick();
    const handle = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [showOtherUsers]);

  // Disasters are currently not exposed via a list endpoint; they are
  // observable via active notifications + cordons (which the web operator
  // wraps around them). We render those as the disaster overlay.
  const polygons = useMemo(() => {
    const merged: Array<{ id: string; coords: any[]; color: string; label: string }> = [];
    for (const n of notifs) {
      const coords = polygonToCoords(n.geometry);
      if (coords.length) merged.push({ id: `n-${n.id}`, coords, color: colors.danger, label: n.reason });
    }
    for (const c of cordons) {
      const coords = polygonToCoords(c.geometry);
      if (coords.length)
        merged.push({
          id: `c-${c.id}`,
          coords,
          color: colors.warning,
          label: c.reason ?? 'Cordon',
        });
    }
    return merged;
  }, [notifs, cordons]);

  const initialRegion: Region = myLocation
    ? { latitude: myLocation.lat, longitude: myLocation.lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }
    : MANHATTAN;

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFillObject}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsCompass
        onPress={(e) => {
          const { latitude, longitude } = e.nativeEvent.coordinate;
          onMapPress?.(latitude, longitude);
        }}
      >
        {/* Hazard polygons (notifications + cordons) */}
        {polygons.map((p) => (
          <Polygon
            key={p.id}
            coordinates={p.coords}
            strokeColor={p.color}
            fillColor={`${p.color}33`}
            strokeWidth={2}
          />
        ))}

        {/* Other users — only shown to workers/admin */}
        {showOtherUsers &&
          citizens
            .filter((c) => c.id !== myUserId)
            .map((c) => (
              <Marker
                key={c.id}
                coordinate={{ latitude: c.lat, longitude: c.lng }}
                title={c.name}
                description={`Citizen · ${c.status}`}
                pinColor={colors.citizen}
              />
            ))}
        {workers
          .filter((w) => w.id !== myUserId)
          .map((w) => (
            <Marker
              key={w.id}
              coordinate={{ latitude: w.lat, longitude: w.lng }}
              title={w.name}
              description={`${w.role} · ${w.status}`}
              pinColor={colors.worker}
            />
          ))}

        {/* Destination */}
        {destination && (
          <Marker
            coordinate={{ latitude: destination.lat, longitude: destination.lng }}
            title="Destination"
            pinColor={colors.success}
          />
        )}

        {/* Route polyline */}
        {route && route.coordinates.length > 1 && (
          <Polyline
            coordinates={route.coordinates}
            strokeColor={colors.info}
            strokeWidth={5}
          />
        )}

        {/* "Me" — large ring + dot so the user can spot themselves quickly */}
        {myLocation && (
          <>
            <Circle
              center={{ latitude: myLocation.lat, longitude: myLocation.lng }}
              radius={80}
              strokeColor={roleAccent(myRole)}
              fillColor={`${roleAccent(myRole)}22`}
              strokeWidth={3}
            />
            <Marker
              coordinate={{ latitude: myLocation.lat, longitude: myLocation.lng }}
              title="You"
              description={myRole === 'citizen' ? 'Citizen' : 'Emergency Worker'}
              pinColor={roleAccent(myRole)}
            />
          </>
        )}
      </MapView>

      {polygons.length > 0 && (
        <View style={styles.legend}>
          <Text style={styles.legendText}>
            {polygons.length} active hazard{polygons.length === 1 ? '' : 's'} nearby
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  legend: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  legendText: { color: colors.textPrimary, fontWeight: '600' },
});
