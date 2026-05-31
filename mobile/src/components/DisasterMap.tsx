// Shared map view used by Citizen, Worker, and Admin Calls screens.
//
// Rendered via Leaflet inside a WebView so the mobile basemap matches the web
// operator console. The basemap (and every injected marker/route color) follows
// the active theme: CartoDB dark tiles in dark mode, Positron light tiles in
// light mode. The WebView is keyed by scheme so it rebuilds cleanly on switch.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';
import { api, MobileCitizen, StationPoint, Notification, Cordon, Route, Disaster, WorkerSubRole } from '@/lib/api';
import { useTheme } from '@/theme';
import { disasterRing, geometryCentroid } from '@/lib/geo';
import { disasterColor, disasterEmoji, disasterLabel } from '@/lib/disasterMeta';
import { MapLegend } from './MapLegend';

const MANHATTAN = { lat: 40.758, lng: -73.9855 };

export type DisasterMapPin = { id: string; lat: number; lng: number; label: string };

type Props = {
  myLocation: { lat: number; lng: number } | null;
  myRole: 'citizen' | 'worker' | 'admin';
  mySubRole?: WorkerSubRole;
  myUserId: string;
  showOtherUsers: boolean;
  destination?: { lat: number; lng: number } | null;
  route?: Route | null;
  onMapPress?: (lat: number, lng: number) => void;
  onPolygonPress?: (eventId: string | null, label: string) => void;
  pins?: DisasterMapPin[];
  onDisastersChange?: (disasters: Disaster[]) => void;
  /** Extra px to lift the bottom-right legend above this screen's own bottom
   *  panel (route / dispatch card) so the chip never collides with it. */
  legendBottom?: number;
  /** Turn-by-turn mode: keep the map zoomed in and locked on the user. */
  navMode?: boolean;
};

type PolygonItem = {
  id: string;
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

type MapPalette = { bg: string; tiles: string; pinBorder: string; routeColor: string; destColor: string; pinColor: string };

function buildLeafletHtml(p: MapPalette): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: ${p.bg}; }
  /* --mscale is updated on every zoom so markers shrink as you zoom out
     instead of staying huge over the whole city. transform-origin keeps them
     pinned to their anchor point. */
  .me-dot { width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 4px rgba(255,255,255,0.25); transform: scale(var(--mscale,1)); transform-origin: center; }
  .pin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid ${p.pinBorder}; box-shadow: 0 0 6px rgba(0,0,0,0.5); transform: scale(var(--mscale,1)); transform-origin: center; }
  .station-ico { font-size: 20px; line-height: 20px; text-shadow: 0 1px 2px #000; display: inline-block; transform: scale(var(--mscale,1)); transform-origin: center; }
  /* Emoji chip dropped at a disaster's centroid so its TYPE is readable on the
     map without tapping. Non-interactive so taps fall through to the zone. */
  .disaster-ico { font-size: 16px; line-height: 26px; width: 26px; height: 26px; text-align: center; border-radius: 50%; background: rgba(10,14,23,0.6); box-shadow: 0 0 0 1.5px rgba(255,255,255,0.45); transform: scale(var(--mscale,1)); transform-origin: center; }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var post = function (payload) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload)); };
  var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([${MANHATTAN.lat}, ${MANHATTAN.lng}], 13);
  L.tileLayer('${p.tiles}', { subdomains: 'abcd', maxZoom: 20, keepBuffer: 8 }).addTo(map);
  map.on('click', function (e) { post({ type: 'press', lat: e.latlng.lat, lng: e.latlng.lng }); });

  // Scale markers with zoom: full size at street zoom (>=14), shrinking as the
  // map zooms out so icons don't blanket the whole city. Capped at 1 so they
  // never balloon when zoomed in.
  function applyMarkerScale() {
    var z = map.getZoom();
    var s = Math.max(0.4, Math.min(1, (z - 9) / 5));
    document.documentElement.style.setProperty('--mscale', String(s));
  }
  map.on('zoom', applyMarkerScale);
  map.on('zoomend', applyMarkerScale);
  applyMarkerScale();

  var polygonLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup().addTo(map);
  var stationLayer = L.layerGroup().addTo(map);
  var pinLayer = L.layerGroup().addTo(map);
  var otherUserLayer = L.layerGroup().addTo(map);
  var destinationLayer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var meLayer = L.layerGroup().addTo(map);
  var centeredOnMe = false;
  var lastRouteSig = '';

  // Station markers mirror the web operator console exactly: an emoji DivIcon
  // (🚒 fire · 🏥 hospital · 🚓 police) with the station name as a tooltip.
  var STATION_EMOJI = { fire: '🚒', hospital: '🏥', police: '🚓' };
  function makeStationIcon(kind) {
    return L.divIcon({ className: '', html: '<div class="station-ico">' + (STATION_EMOJI[kind] || '📍') + '</div>', iconSize: [24, 24], iconAnchor: [12, 12] });
  }
  function makeDisasterIcon(emoji) {
    return L.divIcon({ className: '', html: '<div class="disaster-ico">' + emoji + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  }
  function makePinIcon(color) {
    return L.divIcon({ className: '', html: '<div class="pin" style="background:' + color + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  }
  function makeMeIcon(color) {
    return L.divIcon({ className: '', html: '<div class="me-dot" style="background:' + color + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  window.__applyState = function (state) {
    try {
      polygonLayer.clearLayers();
      (state.polygons || []).forEach(function (pg) {
        var latlngs = (pg.ring || []).map(function (c) { return [c[1], c[0]]; });
        if (latlngs.length < 3) return;
        var poly = L.polygon(latlngs, { color: pg.color, weight: 2, fillColor: pg.color, fillOpacity: pg.fillOpacity, dashArray: pg.dashArray || undefined });
        poly.on('click', function (ev) { L.DomEvent.stopPropagation(ev); post({ type: 'polygonPress', eventId: pg.eventId, label: pg.label }); });
        poly.addTo(polygonLayer);
      });

      // Disaster type-emoji chips at each zone centroid (non-interactive → taps
      // pass through to the polygon so the detail sheet still opens).
      labelLayer.clearLayers();
      (state.disasterLabels || []).forEach(function (d) {
        L.marker([d.lat, d.lng], { icon: makeDisasterIcon(d.emoji), interactive: false, keyboard: false }).addTo(labelLayer);
      });

      stationLayer.clearLayers();
      (state.stations || []).forEach(function (s) {
        var m = L.marker([s.lat, s.lng], { icon: makeStationIcon(s.kind), keyboard: false });
        if (s.label) m.bindTooltip(s.label, { direction: 'top', offset: [0, -8] });
        m.addTo(stationLayer);
      });

      pinLayer.clearLayers();
      (state.pins || []).forEach(function (pin) { L.marker([pin.lat, pin.lng], { icon: makePinIcon('${p.pinColor}') }).bindPopup(pin.label).addTo(pinLayer); });

      otherUserLayer.clearLayers();
      (state.otherUsers || []).forEach(function (u) { L.marker([u.lat, u.lng], { icon: makePinIcon(u.color) }).bindPopup(u.title + (u.subtitle ? '<br/>' + u.subtitle : '')).addTo(otherUserLayer); });

      destinationLayer.clearLayers();
      if (state.destination) { L.marker([state.destination.lat, state.destination.lng], { icon: makePinIcon('${p.destColor}') }).bindPopup('Destination').addTo(destinationLayer); }

      routeLayer.clearLayers();
      if (state.route && state.route.length > 1) {
        var poly = L.polyline(state.route, { color: '${p.routeColor}', weight: 5, opacity: 0.9 }).addTo(routeLayer);
        // Auto-fit ONCE per distinct route — the operator workflow needs to see the
        // whole leg the moment a dispatch arrives, otherwise the route can draw
        // off-screen and look like "nothing happened". Signature = first+last
        // coordinate (cheap and unique enough for a single route at a time). After
        // the initial fit we leave the viewport alone so the user can pan freely.
        var first = state.route[0]; var last = state.route[state.route.length - 1];
        var sig = first[0] + ',' + first[1] + '|' + last[0] + ',' + last[1] + '|' + state.route.length;
        if (sig !== lastRouteSig) {
          try { map.fitBounds(poly.getBounds(), { padding: [60, 60], maxZoom: 16, animate: true }); } catch (e) {}
          lastRouteSig = sig;
        }
      } else {
        lastRouteSig = '';
      }

      meLayer.clearLayers();
      if (state.me) {
        L.circle([state.me.lat, state.me.lng], { radius: 80, color: state.me.color, fillColor: state.me.color, fillOpacity: 0.15, weight: 3 }).addTo(meLayer);
        L.marker([state.me.lat, state.me.lng], { icon: makeMeIcon(state.me.color) }).bindPopup(state.me.title).addTo(meLayer);
        // Navigation mode: keep the map zoomed in and locked on the user as they
        // move. Otherwise just centre once on first fix.
        if (state.follow) { map.setView([state.me.lat, state.me.lng], 17, { animate: true }); }
        else if (!centeredOnMe && !state.route) { map.setView([state.me.lat, state.me.lng], 14); centeredOnMe = true; }
      }
    } catch (err) { post({ type: 'error', message: String(err && err.message || err) }); }
  };

  post({ type: 'ready' });
})();
true;
</script>
</body>
</html>`;
}

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
  legendBottom,
  navMode,
}: Props) {
  const t = useTheme();
  const webviewRef = useRef<WebViewType | null>(null);
  const [ready, setReady] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [cordons, setCordons] = useState<Cordon[]>([]);
  const [disasters, setDisasters] = useState<Disaster[]>([]);
  const [citizens, setCitizens] = useState<MobileCitizen[]>([]);
  const [fireStations, setFireStations] = useState<StationPoint[]>([]);
  const [hospitals, setHospitals] = useState<StationPoint[]>([]);
  const [policeStations, setPoliceStations] = useState<StationPoint[]>([]);

  // Colours the user's own "me" dot by their sub-role; individual workers are no
  // longer plotted (their stations are shown instead).
  const workerAccent = (sub?: string | null) =>
    sub === 'firefighter' ? t.color.firefighter : sub === 'police' ? t.color.police : sub === 'paramedic' ? t.color.paramedic : t.color.worker;

  const html = useMemo(
    () =>
      buildLeafletHtml({
        bg: t.color.bg,
        tiles:
          t.scheme === 'light'
            ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        pinBorder: t.color.bg,
        routeColor: t.color.primary,
        destColor: t.color.success,
        pinColor: t.color.primary,
      }),
    [t.scheme, t.color.bg, t.color.primary, t.color.success],
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [notifs, cordons, disasters, citizens, fireStations, hospitals, policeStations] = await Promise.all([
          api.listNotifications().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => []),
          api.listCordons().then((rs) => rs.filter((r) => r.source === 'ai')).catch(() => []),
          // Disasters are gated on citizen reports (see api.listReportedDisasters):
          // a placed disaster only appears once users report it, any source.
          api.listReportedDisasters().catch(() => []),
          // Other citizens stay private to citizens — only fetched when allowed.
          showOtherUsers ? api.listCitizens().catch(() => []) : Promise.resolve([]),
          // Public infrastructure — fire / hospital / police stations — is shown
          // on EVERY user's map (synced with the web operator console).
          api.listFireStations().catch(() => []),
          api.listHospitals().catch(() => []),
          api.listPoliceStations().catch(() => []),
        ]);
        if (cancelled) return;
        setNotifs(notifs);
        setCordons(cordons);
        setDisasters(disasters);
        setCitizens(citizens);
        setFireStations(fireStations);
        setHospitals(hospitals);
        setPoliceStations(policeStations);
        onDisastersChange?.(disasters);
      } catch {
        /* skip frame on error */
      }
    };
    tick();
    const handle = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [showOtherUsers]);

  const polygons = useMemo<PolygonItem[]>(() => {
    const merged: PolygonItem[] = [];
    for (const d of disasters) {
      if (d.status !== 'active') continue;
      const ring = disasterRing(d.area_geometry, d.severity);
      if (ring.length < 3) continue;
      // Color each disaster by TYPE (synced with the web console) so the map
      // reads "what happened where" at a glance, not just "a hazard".
      merged.push({ id: `d-${d.id}`, ring, color: disasterColor(d.disaster_type), fillOpacity: 0.25, label: `${disasterLabel(d.disaster_type)} · severity ${d.severity}`, eventId: d.id });
    }
    for (const n of notifs) {
      const ring = polygonToRing(n.geometry);
      if (ring.length) merged.push({ id: `n-${n.id}`, ring, color: t.color.hazardNotification, fillOpacity: 0.15, label: n.reason, eventId: n.event_id ?? null });
    }
    for (const c of cordons) {
      const ring = polygonToRing(c.geometry);
      if (ring.length) merged.push({ id: `c-${c.id}`, ring, color: t.color.hazardCordon, fillOpacity: 0.12, dashArray: '4 6', label: c.reason ?? 'Cordon', eventId: c.event_id ?? null });
    }
    return merged;
  }, [notifs, cordons, disasters, t.color.danger, t.color.hazardNotification, t.color.hazardCordon]);

  // Distinct active disaster TYPES (with zone counts) for the legend, so it
  // lists exactly what's on the map right now — color + emoji per type.
  const disasterTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of disasters) if (d.status === 'active') counts.set(d.disaster_type, (counts.get(d.disaster_type) ?? 0) + 1);
    return [...counts.entries()].map(([type, count]) => ({ type, count }));
  }, [disasters]);

  useEffect(() => {
    if (!ready) return;
    const meColor = myRole === 'worker' ? workerAccent(mySubRole) : myRole === 'citizen' ? t.color.citizen : t.color.admin;
    const subRoleLabel =
      mySubRole === 'firefighter' ? 'Firefighter' : mySubRole === 'paramedic' ? 'Paramedic' : mySubRole === 'police' ? 'Police' : 'Emergency Worker';
    const meTitle = myRole === 'citizen' ? 'You · Citizen' : myRole === 'worker' ? `You · ${subRoleLabel}` : 'You · Operator';
    // Only other citizens are ever plotted as people (and only where allowed).
    // Individual public servants are NOT shown — their stations are, below.
    const otherUsers = showOtherUsers
      ? citizens.filter((c) => c.id !== myUserId).map((c) => ({ lat: c.lat, lng: c.lng, color: t.color.citizen, title: c.name, subtitle: `Citizen · ${c.status}` }))
      : [];

    const stations = [
      ...fireStations.map((s) => ({ lat: s.lat, lng: s.lng, kind: 'fire', label: s.name ?? 'Fire station' })),
      ...hospitals.map((s) => ({ lat: s.lat, lng: s.lng, kind: 'hospital', label: s.name ?? 'Hospital' })),
      ...policeStations.map((s) => ({ lat: s.lat, lng: s.lng, kind: 'police', label: s.name ?? 'Police station' })),
    ];

    // One type-emoji chip per active disaster, dropped at its centroid.
    const disasterLabels = disasters
      .filter((d) => d.status === 'active')
      .map((d) => {
        const c = geometryCentroid(d.area_geometry);
        return c ? { lat: c.lat, lng: c.lng, emoji: disasterEmoji(d.disaster_type) } : null;
      })
      .filter(Boolean);

    const state = {
      polygons,
      stations,
      disasterLabels,
      pins: pins ?? [],
      otherUsers,
      destination: destination ?? null,
      route: route?.coordinates.map((c) => [c.latitude, c.longitude]) ?? null,
      me: myLocation ? { lat: myLocation.lat, lng: myLocation.lng, color: meColor, title: meTitle } : null,
      follow: !!navMode,
    };
    webviewRef.current?.injectJavaScript(`window.__applyState && window.__applyState(${JSON.stringify(state)}); true;`);
  }, [ready, polygons, pins, showOtherUsers, citizens, fireStations, hospitals, policeStations, myLocation, myRole, mySubRole, myUserId, destination, route, navMode, t.color]);

  const handleMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') setReady(true);
      else if (msg.type === 'press') onMapPress?.(msg.lat, msg.lng);
      else if (msg.type === 'polygonPress') onPolygonPress?.(msg.eventId ?? null, msg.label ?? '');
    } catch {
      /* ignore malformed bridge messages */
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: t.color.bg }]}>
      <WebView
        key={t.scheme}
        ref={webviewRef}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        style={[styles.webview, { backgroundColor: t.color.bg }]}
        onMessage={handleMessage}
        onLoadStart={() => setReady(false)}
        androidLayerType="hardware"
        mixedContentMode="never"
      />

      <MapLegend
        myRole={myRole}
        mySubRole={mySubRole}
        bottomOffset={legendBottom}
        showOtherUsers={showOtherUsers}
        hasDestination={!!destination}
        hasRoute={!!(route && route.coordinates.length > 1)}
        hasPins={!!(pins && pins.length > 0)}
        stationCounts={{ fire: fireStations.length, hospital: hospitals.length, police: policeStations.length }}
        disasterTypes={disasterTypeCounts}
        citizenCount={citizens.filter((c) => c.id !== myUserId).length}
        stats={{ dangerZones: disasters.filter((d) => d.status === 'active').length, advisories: notifs.length, cordons: cordons.length }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
