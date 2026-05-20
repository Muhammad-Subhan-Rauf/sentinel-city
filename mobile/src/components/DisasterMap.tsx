// Shared map view used by Citizen, Worker, and Admin Calls screens.
//
// Rendered via Leaflet inside a WebView so the mobile basemap matches the web
// operator console exactly (CartoDB dark, same hazard polygon palette). Tile
// traffic goes out over the phone's normal network; only API traffic goes
// through adb reverse.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';
import { api, MobileCitizen, MobileWorker, Notification, Cordon, Route, Disaster, WorkerSubRole } from '@/lib/api';
import { colors, roleAccent, workerAccent } from '@/lib/colors';
import { disasterRing } from '@/lib/geo';
import { MapLegend } from './MapLegend';

const MANHATTAN = { lat: 40.758, lng: -73.9855 };

export type DisasterMapPin = {
  id: string;
  lat: number;
  lng: number;
  label: string;
};

type Props = {
  myLocation: { lat: number; lng: number } | null;
  myRole: 'citizen' | 'worker' | 'admin';
  // Only meaningful when myRole === 'worker'; selects the per-subrole accent
  // for the "me" marker and the matching legend row.
  mySubRole?: WorkerSubRole;
  myUserId: string;
  showOtherUsers: boolean;
  destination?: { lat: number; lng: number } | null;
  route?: Route | null;
  onMapPress?: (lat: number, lng: number) => void;
  onPolygonPress?: (eventId: string | null, label: string) => void;
  pins?: DisasterMapPin[];
  // Called whenever the active-disaster list changes, so the parent screen
  // can surface a DANGER banner or other in-zone alerts.
  onDisastersChange?: (disasters: Disaster[]) => void;
};

type PolygonItem = {
  id: string;
  // GeoJSON-style [lng, lat] ring — passed straight to Leaflet.GeoJSON
  ring: Array<[number, number]>;
  color: string;
  fillOpacity: number;
  dashArray?: string;
  label: string;
  eventId: string | null;
};

function polygonToRing(geometry: any): Array<[number, number]> {
  if (!geometry || geometry.type !== 'Polygon') return [];
  return geometry.coordinates[0] ?? [];
}

// One-shot HTML payload. Map is created on DOMContentLoaded; subsequent state
// arrives via window.__applyState (called by RN through injectJavaScript).
// All overlay state lives in window-scoped vars so the map doesn't rebuild on
// every prop change.
const LEAFLET_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: ${colors.bg}; }
  .me-dot {
    width: 18px; height: 18px; border-radius: 50%;
    border: 3px solid #fff; box-shadow: 0 0 0 4px rgba(255,255,255,0.25);
  }
  .pin {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid #0b1220; box-shadow: 0 0 6px rgba(0,0,0,0.6);
  }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var post = function (payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  };

  var map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([${MANHATTAN.lat}, ${MANHATTAN.lng}], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20,
    keepBuffer: 8,
  }).addTo(map);

  map.on('click', function (e) {
    post({ type: 'press', lat: e.latlng.lat, lng: e.latlng.lng });
  });

  // Layer groups — wiped & rebuilt on each setState call. Cheap: counts are
  // small (handful of polygons, dozens of markers at most).
  var polygonLayer = L.layerGroup().addTo(map);
  var pinLayer = L.layerGroup().addTo(map);
  var otherUserLayer = L.layerGroup().addTo(map);
  var destinationLayer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var meLayer = L.layerGroup().addTo(map);

  var centeredOnMe = false;

  function makePinIcon(color) {
    return L.divIcon({
      className: '',
      html: '<div class="pin" style="background:' + color + '"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function makeMeIcon(color) {
    return L.divIcon({
      className: '',
      html: '<div class="me-dot" style="background:' + color + '"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  window.__applyState = function (state) {
    try {
      // Polygons (notifications + cordons)
      polygonLayer.clearLayers();
      (state.polygons || []).forEach(function (p) {
        var latlngs = (p.ring || []).map(function (c) { return [c[1], c[0]]; });
        if (latlngs.length < 3) return;
        var poly = L.polygon(latlngs, {
          color: p.color,
          weight: 2,
          fillColor: p.color,
          fillOpacity: p.fillOpacity,
          dashArray: p.dashArray || undefined,
        });
        poly.on('click', function (ev) {
          L.DomEvent.stopPropagation(ev);
          post({ type: 'polygonPress', eventId: p.eventId, label: p.label });
        });
        poly.addTo(polygonLayer);
      });

      // Citizen-report pins
      pinLayer.clearLayers();
      (state.pins || []).forEach(function (pin) {
        L.marker([pin.lat, pin.lng], { icon: makePinIcon('${colors.info}') })
          .bindPopup(pin.label)
          .addTo(pinLayer);
      });

      // Other users
      otherUserLayer.clearLayers();
      (state.otherUsers || []).forEach(function (u) {
        L.marker([u.lat, u.lng], { icon: makePinIcon(u.color) })
          .bindPopup(u.title + (u.subtitle ? '<br/>' + u.subtitle : ''))
          .addTo(otherUserLayer);
      });

      // Destination
      destinationLayer.clearLayers();
      if (state.destination) {
        L.marker([state.destination.lat, state.destination.lng], {
          icon: makePinIcon('${colors.success}'),
        }).bindPopup('Destination').addTo(destinationLayer);
      }

      // Route polyline
      routeLayer.clearLayers();
      if (state.route && state.route.length > 1) {
        L.polyline(state.route, {
          color: '${colors.info}',
          weight: 5,
          opacity: 0.9,
        }).addTo(routeLayer);
      }

      // "Me" — ring + dot
      meLayer.clearLayers();
      if (state.me) {
        L.circle([state.me.lat, state.me.lng], {
          radius: 80,
          color: state.me.color,
          fillColor: state.me.color,
          fillOpacity: 0.15,
          weight: 3,
        }).addTo(meLayer);
        L.marker([state.me.lat, state.me.lng], { icon: makeMeIcon(state.me.color) })
          .bindPopup(state.me.title)
          .addTo(meLayer);
        if (!centeredOnMe) {
          map.setView([state.me.lat, state.me.lng], 14);
          centeredOnMe = true;
        }
      }
    } catch (err) {
      post({ type: 'error', message: String(err && err.message || err) });
    }
  };

  post({ type: 'ready' });
})();
true;
</script>
</body>
</html>`;

export function DisasterMap({
  myLocation,
  myRole,
  mySubRole,
  myUserId,
  showOtherUsers,
  destination,
  route,
  onMapPress,
  onPolygonPress,
  pins,
  onDisastersChange,
}: Props) {
  const webviewRef = useRef<WebViewType | null>(null);
  const [ready, setReady] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [cordons, setCordons] = useState<Cordon[]>([]);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const [citizens, setCitizens] = useState<MobileCitizen[]>([]);
  const [workers, setWorkers] = useState<MobileWorker[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [notifs, cordons, disasters, citizens, workers] = await Promise.all([
          api.listNotifications().catch(() => []),
          api.listCordons().catch(() => []),
          // Live disaster footprints — citizens see these to know where the
          // danger actually is, not just the operator-drawn evacuation polygon.
          api.listDisasters().catch(() => []),
          showOtherUsers ? api.listCitizens().catch(() => []) : Promise.resolve([]),
          showOtherUsers ? api.listWorkers().catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setNotifs(notifs);
        setCordons(cordons);
        setDisasters(disasters);
        setCitizens(citizens);
        setWorkers(workers);
        onDisastersChange?.(disasters);
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
    // Disaster footprints first so they paint underneath operator overlays.
    // Point-type disasters become a severity-scaled circle so they're visible
    // on the map and not just a 0-area dot.
    for (const d of disasters) {
      if (d.status !== 'active') continue;
      const ring = disasterRing(d.area_geometry, d.severity);
      if (ring.length < 3) continue;
      merged.push({
        id: `d-${d.id}`,
        ring,
        color: colors.danger,
        fillOpacity: 0.22,
        label: `${d.disaster_type.replace('_', ' ')} · severity ${d.severity}`,
        eventId: d.id,
      });
    }
    for (const n of notifs) {
      const ring = polygonToRing(n.geometry);
      if (ring.length)
        merged.push({
          id: `n-${n.id}`,
          ring,
          color: colors.hazardNotification,
          fillOpacity: 0.15,
          label: n.reason,
          eventId: n.event_id ?? null,
        });
    }
    for (const c of cordons) {
      const ring = polygonToRing(c.geometry);
      if (ring.length)
        merged.push({
          id: `c-${c.id}`,
          ring,
          color: colors.hazardCordon,
          fillOpacity: 0.12,
          dashArray: '4 6',
          label: c.reason ?? 'Cordon',
          eventId: c.event_id ?? null,
        });
    }
    return merged;
  }, [notifs, cordons, disasters]);

  // Push state into the WebView whenever anything visible changes. Stringify
  // once; the WebView parses it inside __applyState.
  useEffect(() => {
    if (!ready) return;
    // Color the "me" dot by sub-role when worker (red/rose/blue), else by role.
    const meColor = myRole === 'worker' ? workerAccent(mySubRole) : roleAccent(myRole);
    const subRoleLabel =
      mySubRole === 'firefighter'
        ? 'Firefighter'
        : mySubRole === 'paramedic'
          ? 'Paramedic'
          : mySubRole === 'police'
            ? 'Police'
            : 'Emergency Worker';
    const meTitle =
      myRole === 'citizen'
        ? 'You · Citizen'
        : myRole === 'worker'
          ? `You · ${subRoleLabel}`
          : 'You · Operator';
    const otherUsers = showOtherUsers
      ? [
          ...citizens
            .filter((c) => c.id !== myUserId)
            .map((c) => ({
              lat: c.lat,
              lng: c.lng,
              color: colors.citizen,
              title: c.name,
              subtitle: `Citizen · ${c.status}`,
            })),
          ...workers
            .filter((w) => w.id !== myUserId)
            .map((w) => ({
              lat: w.lat,
              lng: w.lng,
              // Each worker dot is painted in its dispatch color so an admin
              // can read who's who without tapping.
              color: workerAccent(w.role),
              title: w.name,
              subtitle: `${w.role} · ${w.status}`,
            })),
        ]
      : [];

    const state = {
      polygons,
      pins: pins ?? [],
      otherUsers,
      destination: destination ?? null,
      route: route?.coordinates.map((c) => [c.latitude, c.longitude]) ?? null,
      me: myLocation ? { lat: myLocation.lat, lng: myLocation.lng, color: meColor, title: meTitle } : null,
    };
    const js = `window.__applyState && window.__applyState(${JSON.stringify(state)}); true;`;
    webviewRef.current?.injectJavaScript(js);
  }, [ready, polygons, pins, showOtherUsers, citizens, workers, myLocation, myRole, mySubRole, myUserId, destination, route]);

  const handleMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        setReady(true);
      } else if (msg.type === 'press') {
        onMapPress?.(msg.lat, msg.lng);
      } else if (msg.type === 'polygonPress') {
        onPolygonPress?.(msg.eventId ?? null, msg.label ?? '');
      }
    } catch {
      // Malformed messages are ignored — the JS bridge will retry next event.
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={{ html: LEAFLET_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        // Avoid the white flash on first load against the dark app chrome.
        style={styles.webview}
        onMessage={handleMessage}
        // Android: hardware-accelerated layer keeps tile panning smooth.
        androidLayerType="hardware"
        // Some Android builds block the CDN over plain http; Leaflet uses
        // https everywhere we configure, so this stays false.
        mixedContentMode="never"
      />

      <MapLegend
        myRole={myRole}
        mySubRole={mySubRole}
        showOtherUsers={showOtherUsers}
        hasDestination={!!destination}
        hasRoute={!!(route && route.coordinates.length > 1)}
        hasPins={!!(pins && pins.length > 0)}
        workerCounts={{
          firefighter: workers.filter((w) => w.id !== myUserId && w.role === 'firefighter').length,
          paramedic: workers.filter((w) => w.id !== myUserId && w.role === 'paramedic').length,
          police: workers.filter((w) => w.id !== myUserId && w.role === 'police').length,
        }}
        citizenCount={citizens.filter((c) => c.id !== myUserId).length}
        stats={{
          dangerZones: disasters.filter((d) => d.status === 'active').length,
          advisories: notifs.length,
          cordons: cordons.length,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  webview: { flex: 1, backgroundColor: colors.bg },
});
