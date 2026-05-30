// Tiny single-purpose map: one draggable pin on a CartoDB Leaflet basemap that
// follows the app theme (dark / light). Reports drag-end back to the host.
// Used by Settings where the citizen/worker sets their persistent location.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebView as WebViewType } from 'react-native-webview';
import { useTheme } from '@/theme';

type Props = {
  pin: { lat: number; lng: number };
  accent: string;
  onPinChange: (loc: { lat: number; lng: number }) => void;
};

function buildHtml(bg: string, tiles: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: ${bg}; }
  .me-dot { width: 20px; height: 20px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 4px rgba(255,255,255,0.25); }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var post = function (msg) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); };
  var map = L.map('map', { zoomControl: true, attributionControl: false });
  L.tileLayer('${tiles}', { subdomains: 'abcd', maxZoom: 20, keepBuffer: 8 }).addTo(map);
  var marker = null;
  function makeIcon(color) {
    return L.divIcon({ className: '', html: '<div class="me-dot" style="background:' + color + '"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
  }
  window.__setPin = function (state) {
    if (!marker) {
      marker = L.marker([state.lat, state.lng], { draggable: true, icon: makeIcon(state.color) }).addTo(map);
      marker.bindTooltip('Drag to move', { direction: 'top', opacity: 0.9 });
      marker.on('dragend', function (e) { var ll = e.target.getLatLng(); post({ type: 'dragend', lat: ll.lat, lng: ll.lng }); });
    } else {
      marker.setLatLng([state.lat, state.lng]);
      marker.setIcon(makeIcon(state.color));
    }
    if (state.recenter) { map.setView([state.lat, state.lng], state.zoom || 15); }
  };
  map.on('click', function (e) { post({ type: 'tap', lat: e.latlng.lat, lng: e.latlng.lng }); });
  map.setView([40.758, -73.9855], 13);
  post({ type: 'ready' });
})();
true;
</script>
</body>
</html>`;
}

export function LeafletPicker({ pin, accent, onPinChange }: Props) {
  const t = useTheme();
  const webviewRef = useRef<WebViewType | null>(null);
  const [ready, setReady] = useState(false);
  const lastDragRef = useRef<{ lat: number; lng: number } | null>(null);

  const html = useMemo(
    () =>
      buildHtml(
        t.color.bg,
        t.scheme === 'light'
          ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
          : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      ),
    [t.scheme, t.color.bg],
  );

  useEffect(() => {
    if (!ready) return;
    const isOwnDrag = lastDragRef.current && lastDragRef.current.lat === pin.lat && lastDragRef.current.lng === pin.lng;
    const state = { lat: pin.lat, lng: pin.lng, color: accent, recenter: !isOwnDrag, zoom: 15 };
    webviewRef.current?.injectJavaScript(`window.__setPin && window.__setPin(${JSON.stringify(state)}); true;`);
  }, [ready, pin.lat, pin.lng, accent]);

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        setReady(true);
      } else if (msg.type === 'dragend' || msg.type === 'tap') {
        const loc = { lat: msg.lat, lng: msg.lng };
        lastDragRef.current = loc;
        onPinChange(loc);
      }
    } catch {
      /* malformed messages ignored */
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
        onMessage={onMessage}
        onLoadStart={() => setReady(false)}
        androidLayerType="hardware"
        mixedContentMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 220 },
  webview: { flex: 1 },
});
