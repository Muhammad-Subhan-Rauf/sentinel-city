// Shared map view used by Citizen, Worker, and Admin Calls screens. Renders:
//   - "me" marker (large, pulsing, role-coloured ring) so the user can find self
//   - other mobile users (only when showOtherUsers is true)
//   - active notifications & cordons as hazard polygons (yellow / orange)
//   - optional destination + route polyline
//   - optional report pins (admin Calls screen)

import React, { useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, Text } from 'react-native';
import MapView, { Marker, Polygon, Polyline, Circle, UrlTile } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import { api, MobileCitizen, MobileWorker, Notification, Cordon, Route } from '@/lib/api';
import { colors, roleAccent } from '@/lib/colors';

const MANHATTAN: Region = {
  latitude: 40.758,
  longitude: -73.9855,
  latitudeDelta: 0.06,
  longitudeDelta: 0.06,
};

const CARTODB_DARK_URL = 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';

export type DisasterMapPin = {
  id: string;
  lat: number;
  lng: number;
  label: string;
};

type Props = {
  myLocation: { lat: number; lng: number } | null;
  myRole: 'citizen' | 'worker' | 'admin';
  myUserId: string;
  showOtherUsers: boolean;
  destination?: { lat: number; lng: number } | null;
  route?: Route | null;
  onMapPress?: (lat: number, lng: number) => void;
  onPolygonPress?: (eventId: string | null, label: string) => void;
  pins?: DisasterMapPin[];
};

type PolygonItem = {
  id: string;
  coords: Array<{ latitude: number; longitude: number }>;
  color: string;
  label: string;
  eventId: string | null;
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
  onPolygonPress,
  pins,
}: Props) {
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
          showOtherUsers ? api.listWorkers().catch(() => []) : Promise.resolve([]),
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

  const polygons = useMemo<PolygonItem[]>(() => {
    const merged: PolygonItem[] = [];
    for (const n of notifs) {
      const coords = polygonToCoords(n.geometry);
      if (coords.length)
        merged.push({
          id: `n-${n.id}`,
          coords,
          color: colors.hazardNotification,
          label: n.reason,
          eventId: n.event_id ?? null,
        });
    }
    for (const c of cordons) {
      const coords = polygonToCoords(c.geometry);
      if (coords.length)
        merged.push({
          id: `c-${c.id}`,
          coords,
          color: colors.hazardCordon,
          label: c.reason ?? 'Cordon',
          eventId: c.event_id ?? null,
        });
    }
    return merged;
  }, [notifs, cordons]);

  const initialRegion: Region = myLocation
    ? { latitude: myLocation.lat, longitude: myLocation.lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }
    : MANHATTAN;

  // On Android, suppress Google's default base so the CartoDB tile overlay
  // becomes the only visible basemap. iOS handles this implicitly via Apple Maps.
  const mapTypeProp = Platform.OS === 'android' ? { mapType: 'none' as const } : {};

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsCompass
        {...mapTypeProp}
        onPress={(e) => {
          const { latitude, longitude } = e.nativeEvent.coordinate;
          onMapPress?.(latitude, longitude);
        }}
      >
        <UrlTile urlTemplate={CARTODB_DARK_URL} maximumZ={19} flipY={false} zIndex={-1} />

        {/* Hazard polygons (notifications + cordons) */}
        {polygons.map((p) => (
          <Polygon
            key={p.id}
            coordinates={p.coords}
            strokeColor={p.color}
            fillColor={`${p.color}33`}
            strokeWidth={2}
            tappable
            onPress={() => onPolygonPress?.(p.eventId, p.label)}
          />
        ))}

        {/* Citizen-report pins (admin Calls screen) */}
        {pins?.map((pin) => (
          <Marker
            key={pin.id}
            coordinate={{ latitude: pin.lat, longitude: pin.lng }}
            title="Citizen report"
            description={pin.label}
            pinColor={colors.info}
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
        {showOtherUsers &&
          workers
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

        {/* "Me" */}
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
              description={myRole === 'citizen' ? 'Citizen' : myRole === 'worker' ? 'Emergency Worker' : 'Operator'}
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
