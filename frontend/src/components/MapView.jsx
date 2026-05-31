// ============================================================
// MapView.jsx — Fullscreen Map with disaster zones, routing, and overlays
// ============================================================
import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import CitizenLayer from './CitizenLayer'
import WaveLayer from './WaveLayer'
import MockCameraLayer from './MockCameraLayer'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Camera and intersection overlays only render at this zoom or deeper —
// at lower zooms the markers crowd into illegible mush.
const OVERLAY_MIN_ZOOM = 14

// ── Route Layer ──────────────────────────────────────────────
// Renders the routing polyline plus start/end markers.
function RouteLayer({ route, waypoints }) {
  const map = useMap()
  const groupRef = useRef(null)

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.remove()
      groupRef.current = null
    }

    const start = waypoints?.start
    const end = waypoints?.end
    if (!start && !end && !route) return

    const group = L.layerGroup()

    if (route?.shape?.length) {
      // Outer casing (darker) + inner stroke for legibility on any basemap.
      L.polyline(route.shape, {
        color: '#0a0a0a',
        weight: 7,
        opacity: 0.55,
        interactive: false,
      }).addTo(group)
      L.polyline(route.shape, {
        color: '#10b981',
        weight: 4,
        opacity: 0.95,
        interactive: false,
      }).addTo(group)
    }

    const waypointMarker = (latLng, color) =>
      L.circleMarker(latLng, {
        radius: 7,
        color,
        weight: 3,
        fillColor: '#0a0a0a',
        fillOpacity: 1,
        interactive: false,
      })

    if (start) waypointMarker([start.lat, start.lng], '#10b981').addTo(group)
    if (end) waypointMarker([end.lat, end.lng], '#ef4444').addTo(group)

    group.addTo(map)
    groupRef.current = group

    return () => {
      if (groupRef.current) {
        groupRef.current.remove()
        groupRef.current = null
      }
    }
  }, [map, route, waypoints])

  return null
}

// ── Station Markers (fire / hospital / police) ───────────────
// Plain Leaflet DivIcon markers showing an emoji + name. No interaction.
function StationMarkers({ stations, emoji, className }) {
  const map = useMap()
  const layersRef = useRef([])

  useEffect(() => {
    // Tear down old markers
    for (const m of layersRef.current) map.removeLayer(m)
    layersRef.current = []
    for (const s of stations) {
      const icon = L.divIcon({
        className,
        html: `<div style="font-size:20px;line-height:20px;text-shadow:0 1px 2px #000;">${emoji}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })
      const m = L.marker([s.lat, s.lng], { icon, interactive: false, keyboard: false }).addTo(map)
      if (s.name) m.bindTooltip(s.name, { permanent: false, direction: 'top', offset: [0, -8] })
      layersRef.current.push(m)
    }
    return () => {
      for (const m of layersRef.current) map.removeLayer(m)
      layersRef.current = []
    }
  }, [map, stations, emoji, className])
  return null
}

function FireStationMarkers({ stations }) {
  return <StationMarkers stations={stations} emoji="🚒" className="fire-station-marker" />
}
function HospitalMarkers({ stations }) {
  return <StationMarkers stations={stations} emoji="🏥" className="hospital-marker" />
}
function PoliceStationMarkers({ stations }) {
  return <StationMarkers stations={stations} emoji="🚓" className="police-station-marker" />
}

// ── Mobile Users Layer ───────────────────────────────────────
// Renders citizens and emergency workers that signed in via the mobile app
// (Expo app at /mobile). Self-fetches every 3s. Distinct highlight:
//   - mobile citizens: cyan ring around a small dot, "📱 citizen" tooltip
//   - mobile workers: hot-pink ring around a small dot, "📱 worker" tooltip
// The ring intentionally clashes with the simulated-citizen palette so the
// operator can tell at a glance which dots are real users.
function MobileUsersLayer() {
  const map = useMap()
  const layersRef = useRef([])
  const [citizens, setCitizens] = useState([])
  const [workers, setWorkers] = useState([])
  const backend = import.meta.env.VITE_BACKEND_URL || ''

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const [cRes, wRes] = await Promise.all([
          fetch(`${backend}/api/citizens`).then((r) => r.ok ? r.json() : { citizens: [] }),
          fetch(`${backend}/api/workers`).then((r) => r.ok ? r.json() : { workers: [] }),
        ])
        if (cancelled) return
        setCitizens(cRes.citizens || [])
        setWorkers(wRes.workers || [])
      } catch {
        /* best-effort */
      }
    }
    tick()
    const handle = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [backend])

  useEffect(() => {
    for (const l of layersRef.current) map.removeLayer(l)
    layersRef.current = []

    const render = (user, role) => {
      const isCitizen = role === 'citizen'
      const ringColor = isCitizen ? '#22d3ee' : '#f43f5e'    // cyan / hot pink
      const ring = L.circleMarker([user.lat, user.lng], {
        radius: 12,
        color: ringColor,
        weight: 3,
        fillOpacity: 0,
        interactive: false,
      }).addTo(map)
      const dot = L.circleMarker([user.lat, user.lng], {
        radius: 5,
        color: '#0b1220',
        weight: 1,
        fillColor: ringColor,
        fillOpacity: 1,
      }).addTo(map)
      dot.bindTooltip(
        `📱 ${user.name} · ${isCitizen ? user.status : `${user.role} · ${user.status}`}`,
        { direction: 'top', offset: [0, -6] }
      )
      layersRef.current.push(ring, dot)
    }

    for (const c of citizens) render(c, 'citizen')
    for (const w of workers) render(w, 'worker')

    return () => {
      for (const l of layersRef.current) map.removeLayer(l)
      layersRef.current = []
    }
  }, [map, citizens, workers])

  return null
}

// ── Station Placer ───────────────────────────────────────────
// When `mode` is true, the next map click reports its lat/lng up via onPlace.
function StationPlacer({ mode, onPlace }) {
  const map = useMap()
  useEffect(() => {
    if (!mode) return
    const container = map.getContainer()
    const prev = container.style.cursor
    container.style.cursor = 'crosshair'
    const onClick = (e) => {
      if (
        map.pm?.globalDrawModeEnabled?.() ||
        map.pm?.globalEditModeEnabled?.() ||
        map.pm?.globalRemovalModeEnabled?.() ||
        map.pm?.globalDragModeEnabled?.()
      ) return
      onPlace({ lat: e.latlng.lat, lng: e.latlng.lng })
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      container.style.cursor = prev
    }
  }, [map, mode, onPlace])
  return null
}

// ── Dispatch Target Circle ───────────────────────────────────
// Shows the operator's pending search-area circle (centre + radius) while
// they're staging a dispatch. Trucks will drive to this circle and patrol
// inside it scanning for smoke. Cleared once the dispatch is sent.
function DispatchTargetCircle({ target, color = '#fbbf24' }) {
  const map = useMap()
  const circleRef = useRef(null)
  useEffect(() => {
    if (!target) {
      if (circleRef.current) {
        map.removeLayer(circleRef.current)
        circleRef.current = null
      }
      return
    }
    const style = {
      color,
      weight: 2,
      dashArray: '6 6',
      fillColor: color,
      fillOpacity: 0.1,
      interactive: false,
    }
    if (!circleRef.current) {
      circleRef.current = L.circle([target.lat, target.lng], { ...style, radius: target.radius || 400 }).addTo(map)
    } else {
      circleRef.current.setLatLng([target.lat, target.lng])
      circleRef.current.setRadius(target.radius || 400)
      circleRef.current.setStyle(style)
    }
    return undefined
  }, [map, target, color])
  useEffect(() => () => {
    if (circleRef.current) {
      map.removeLayer(circleRef.current)
      circleRef.current = null
    }
  }, [map])
  return null
}

// ── Active Dispatch Circles ──────────────────────────────────
// One translucent circle per in-flight dispatch — shows the operator where
// trucks were sent and persists until the dispatch is recalled or its fire
// is resolved. Renders dimmer than the pending pre-dispatch circle so they
// read as "in progress" rather than "stage-and-send".
function ActiveDispatchCircles({ dispatches, color = '#fbbf24' }) {
  const map = useMap()
  const circlesRef = useRef(new Map())
  useEffect(() => {
    const live = new Set()
    const style = {
      color,
      weight: 1.5,
      dashArray: '2 6',
      fillColor: color,
      fillOpacity: 0.05,
      interactive: false,
    }
    for (const d of dispatches) {
      if (!d.target) continue
      live.add(d.id)
      let c = circlesRef.current.get(d.id)
      if (!c) {
        c = L.circle([d.target.lat, d.target.lng], { ...style, radius: d.target.radius || 400 }).addTo(map)
        circlesRef.current.set(d.id, c)
      } else {
        c.setLatLng([d.target.lat, d.target.lng])
        c.setRadius(d.target.radius || 400)
        c.setStyle(style)
      }
    }
    for (const [id, c] of [...circlesRef.current.entries()]) {
      if (!live.has(id)) {
        map.removeLayer(c)
        circlesRef.current.delete(id)
      }
    }
  }, [map, dispatches, color])
  useEffect(() => () => {
    for (const c of circlesRef.current.values()) map.removeLayer(c)
    circlesRef.current.clear()
  }, [map])
  return null
}

// ── Notification & Cordon Polygon Layer ──────────────────────
// ── Weather Region Overlay ───────────────────────────────────
// Tints each weather-bending disaster's geometry with a colour scaled to its
// regional temperature (cold blue → hot red) and binds a tooltip with the full
// meteorological snapshot. City-scope regions have no geometry and are skipped
// here — they show up in the global chip instead.
function weatherTone(temperatureC, condition, bendsWeather = true) {
  // Disasters that don't bend the weather get a neutral grey outline so the
  // map still reads as "this is a non-thermal incident."
  if (bendsWeather === false) return '#a1a1aa'
  // Storm/flood conditions get a blue tone regardless of mid-range temps.
  if (condition === 'severe_storm' || condition === 'heavy_rain') return '#2563eb'
  if (condition === 'light_rain') return '#38bdf8'
  if (condition === 'freezing') return '#60a5fa'
  if (typeof temperatureC !== 'number') return '#71717a'
  if (temperatureC <= 0) return '#1e3a8a'
  if (temperatureC <= 10) return '#0ea5e9'
  if (temperatureC <= 20) return '#22c55e'
  if (temperatureC <= 28) return '#facc15'
  if (temperatureC <= 36) return '#f97316'
  if (temperatureC <= 45) return '#ef4444'
  return '#b91c1c'
}

function weatherTooltipHtml(region) {
  const w = region.weather || {}
  const alerts = Array.isArray(w.alerts) ? w.alerts : []
  const row = (label, value, suffix = '') =>
    value === null || value === undefined
      ? ''
      : `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:1.4"><span style="color:#a1a1aa">${label}</span><span style="color:#e4e4e7;font-variant-numeric:tabular-nums">${value}${suffix}</span></div>`
  const alertsHtml = alerts.length
    ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #3f3f46;display:flex;flex-direction:column;gap:2px">${alerts
        .map(
          (a) =>
            `<div style="font-size:10px;color:#fda4af"><b style="text-transform:uppercase;letter-spacing:.04em">${a.type}</b> · ${a.headline}</div>`,
        )
        .join('')}</div>`
    : ''
  return `
    <div style="min-width:180px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="color:#fafafa;font-weight:600;font-size:12px">${w.label ?? 'Weather'}</span>
        <span style="font-size:16px">${w.icon ?? ''}</span>
      </div>
      <div style="color:#a1a1aa;font-size:10px;margin-bottom:6px">${region.disaster_type} · sev ${region.severity}</div>
      ${row('Temp', w.temperature_c, ' °C')}
      ${row('Dew pt', w.dew_point_c, ' °C')}
      ${row('Humidity', w.humidity_pct, ' %')}
      ${row('Precip', w.precipitation_mm_per_hour, ' mm/h')}
      ${row('Wind', w.wind_speed_kph != null ? `${w.wind_speed_kph} kph @ ${w.wind_direction_deg ?? 0}°` : null)}
      ${row('Pressure', w.pressure_hpa, ' hPa')}
      ${row('Visibility', w.visibility_km, ' km')}
      ${row('AQI', w.air_quality_aqi)}
      ${alertsHtml}
    </div>`
}

function buildBadgeIcon(zoneNumber, colour) {
  // Circular numbered badge at the region's centroid. Acts as the operator's
  // visual link between the map polygon and the right-side WeatherRegionsPanel
  // card for the same zone. Clicking the badge scrolls the panel to the
  // matching card (pointer-events:auto overrides the host pane).
  const num = zoneNumber ?? '·'
  return L.divIcon({
    className: '',
    html: `<div style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:9999px;background:rgba(9,9,11,0.92);border:2px solid ${colour};color:${colour};font-size:12px;font-weight:700;line-height:1;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.45);transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer">${num}</div>`,
    iconSize: [0, 0],
  })
}

function geomLatLngsFor(r) {
  const geom = r.geometry?.type === 'Feature' ? r.geometry.geometry : r.geometry
  const gtype = geom?.type
  const coords = geom?.coordinates
  if (gtype === 'Polygon' && Array.isArray(coords?.[0])) {
    return { kind: 'polygon', latlngs: coords[0].map(([lng, lat]) => [lat, lng]) }
  }
  if (gtype === 'MultiPolygon' && Array.isArray(coords?.[0]?.[0])) {
    return { kind: 'polygon', latlngs: coords.map((p) => p[0].map(([lng, lat]) => [lat, lng])) }
  }
  if (r.centroid) {
    const radius = r.radius_m && r.radius_m > 0 ? r.radius_m : 200
    return { kind: 'circle', latlng: [r.centroid.lat, r.centroid.lng], radius }
  }
  return null
}

// Renders one persistent Leaflet polygon per active region (identified by
// event_id) plus a numbered badge at the centroid. The badge's number maps to
// a matching card in the right-side WeatherRegionsPanel — that's the read-only
// link from map to weather details, since direct map clicks were unreliable.
// Layers are updated in place across ticks (never torn down) to keep the
// browser's render path stable.
function WeatherRegionOverlay({ regions = [], onBadgeClick }) {
  const map = useMap()
  // event_id → { layer, badge, kind, currentColour }
  const itemsRef = useRef(new Map())
  // Keep the click handler in a ref so we don't re-bind every badge each
  // time the parent re-renders.
  const onBadgeClickRef = useRef(onBadgeClick)
  useEffect(() => { onBadgeClickRef.current = onBadgeClick }, [onBadgeClick])

  // Custom panes — keep weather overlays above other map layers regardless of
  // creation order.
  useEffect(() => {
    if (!map.getPane('weather-overlay')) {
      const pane = map.createPane('weather-overlay')
      pane.style.zIndex = 480
      pane.style.pointerEvents = 'none'
    }
    if (!map.getPane('weather-overlay-labels')) {
      const pane = map.createPane('weather-overlay-labels')
      pane.style.zIndex = 620
      pane.style.pointerEvents = 'none'
    }
  }, [map])

  useEffect(() => {
    const items = itemsRef.current
    const seen = new Set()

    for (const r of regions) {
      if (!r || !r.event_id || r.scope === 'city') continue
      const geomSpec = geomLatLngsFor(r)
      if (!geomSpec) continue

      seen.add(r.event_id)
      const w = r.weather || {}
      const bends = r.bends_weather !== false
      const colour = weatherTone(w.temperature_c, w.condition, bends)
      const isClearing = r.cleared === true
      // Non-thermal disasters (Robbery, Accident, etc.) get a numbered badge
      // on the map and a card in the panel, but no polygon/circle overlay —
      // it'd add visual noise without conveying any weather signal.
      const drawOutline = bends
      const style = {
        color: colour,
        weight: 2,
        opacity: isClearing ? 0.5 : 0.95,
        fillColor: colour,
        fillOpacity: isClearing ? 0.06 : 0.18,
        dashArray: '4 6',
      }

      let entry = items.get(r.event_id)

      // ── Create on first sight ─────────────────────────────────
      if (!entry || entry.kind !== geomSpec.kind || entry.hasOutline !== drawOutline) {
        if (entry) {
          if (entry.layer) map.removeLayer(entry.layer)
          if (entry.badge) map.removeLayer(entry.badge)
        }
        let layer = null
        if (drawOutline) {
          const layerOpts = { ...style, interactive: false, pane: 'weather-overlay' }
          layer = geomSpec.kind === 'polygon'
            ? L.polygon(geomSpec.latlngs, layerOpts)
            : L.circle(geomSpec.latlng, { ...layerOpts, radius: geomSpec.radius })
          layer.addTo(map)
        }

        let badge = null
        if (r.centroid) {
          badge = L.marker([r.centroid.lat, r.centroid.lng], {
            interactive: true,
            bubblingMouseEvents: false,
            pane: 'weather-overlay-labels',
            icon: buildBadgeIcon(r.zone_number, colour),
          })
          const eventId = r.event_id
          badge.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            onBadgeClickRef.current?.(eventId)
          })
          badge.addTo(map)
        }
        entry = { kind: geomSpec.kind, layer, badge, hasOutline: drawOutline }
        items.set(r.event_id, entry)
      } else {
        // ── Update in place ────────────────────────────────────
        if (entry.layer) {
          if (geomSpec.kind === 'polygon') {
            entry.layer.setLatLngs(geomSpec.latlngs)
          } else {
            entry.layer.setLatLng(geomSpec.latlng)
            entry.layer.setRadius(geomSpec.radius)
          }
          entry.layer.setStyle(style)
        }
        if (r.centroid) {
          if (!entry.badge) {
            entry.badge = L.marker([r.centroid.lat, r.centroid.lng], {
              interactive: true,
              bubblingMouseEvents: false,
              pane: 'weather-overlay-labels',
              icon: buildBadgeIcon(r.zone_number, colour),
            })
            const eventId = r.event_id
            entry.badge.on('click', (e) => {
              L.DomEvent.stopPropagation(e)
              onBadgeClickRef.current?.(eventId)
            })
            entry.badge.addTo(map)
          } else {
            entry.badge.setLatLng([r.centroid.lat, r.centroid.lng])
            entry.badge.setIcon(buildBadgeIcon(r.zone_number, colour))
          }
        } else if (entry.badge) {
          map.removeLayer(entry.badge)
          entry.badge = null
        }
      }
    }

    // Remove layers for regions that disappeared.
    for (const [id, entry] of [...items.entries()]) {
      if (seen.has(id)) continue
      if (entry.layer) map.removeLayer(entry.layer)
      if (entry.badge) map.removeLayer(entry.badge)
      items.delete(id)
    }
  }, [map, regions])

  // Cleanup on unmount only.
  useEffect(() => () => {
    for (const entry of itemsRef.current.values()) {
      if (entry.layer) map.removeLayer(entry.layer)
      if (entry.badge) map.removeLayer(entry.badge)
    }
    itemsRef.current.clear()
  }, [map])

  return null
}

// Renders simple polygons with a translucent fill. Notifications are yellow,
// cordons are amber striped. Read-only — no interaction.
function PolygonOverlay({ items, style }) {
  const map = useMap()
  const layersRef = useRef([])
  useEffect(() => {
    for (const l of layersRef.current) map.removeLayer(l)
    layersRef.current = []
    for (const it of items) {
      const g = it.geometry
      if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates?.[0])) continue
      const latlngs = g.coordinates[0].map(([lng, lat]) => [lat, lng])
      const poly = L.polygon(latlngs, style).addTo(map)
      if (it.reason) poly.bindTooltip(it.reason, { direction: 'center' })
      layersRef.current.push(poly)
    }
    return () => {
      for (const l of layersRef.current) map.removeLayer(l)
      layersRef.current = []
    }
  }, [map, items, style])
  return null
}

// ── Polygon Drawer (one-shot) ────────────────────────────────
// When `mode` flips to true, enables Geoman polygon-draw mode. On completion,
// fires onComplete(geojson) and exits draw mode.
function PolygonDrawer({ mode, onComplete }) {
  const map = useMap()
  useEffect(() => {
    if (!mode) return
    map.pm?.enableDraw?.('Polygon', { snappable: false, finishOn: 'dblclick' })
    const onCreate = (e) => {
      const layer = e.layer
      if (!layer) return
      const gj = layer.toGeoJSON?.()
      // Remove the just-drawn temp layer (the parent state will re-render it
      // through the Notification/CordonLayer with proper styling).
      map.removeLayer(layer)
      map.pm?.disableDraw?.()
      if (gj?.geometry) onComplete(gj.geometry)
    }
    map.on('pm:create', onCreate)
    return () => {
      map.off('pm:create', onCreate)
      map.pm?.disableDraw?.()
    }
  }, [map, mode, onComplete])
  return null
}

// ── Waypoint Picker ──────────────────────────────────────────
// When in pick mode, the next map click reports its lat/lng up via onPick.
// Skips clicks that are part of an active Geoman draw/edit interaction.
function WaypointPicker({ mode, onPick }) {
  const map = useMap()

  useEffect(() => {
    if (!mode) return

    const container = map.getContainer()
    const prevCursor = container.style.cursor
    container.style.cursor = 'crosshair'

    const onClick = (e) => {
      if (
        map.pm?.globalDrawModeEnabled?.() ||
        map.pm?.globalEditModeEnabled?.() ||
        map.pm?.globalRemovalModeEnabled?.() ||
        map.pm?.globalDragModeEnabled?.()
      ) {
        return
      }
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng })
    }

    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      container.style.cursor = prevCursor
    }
  }, [map, mode, onPick])

  return null
}

// ── City Bounds Controller ───────────────────────────────────
// When a city is set, pan/zoom to fit its bounds. No pan or zoom locking —
// the operator can move around freely afterwards.
function CityBoundsController({ city }) {
  const map = useMap()

  useEffect(() => {
    if (city && city.bounds) {
      map.fitBounds(L.latLngBounds(city.bounds), { animate: true })
    }
  }, [map, city])

  return null
}

// ── Focus Controller ─────────────────────────────────────────
// Pans the map to an arbitrary point when its `t` (timestamp) changes.
// Used when the operator clicks a 911 report row in the calls drawer.
function FocusController({ point }) {
  const map = useMap()

  useEffect(() => {
    if (!point) return
    const targetZoom = Math.max(map.getZoom(), 16)
    map.flyTo([point.lat, point.lng], targetZoom, { animate: true, duration: 0.6 })
  }, [map, point?.t])

  return null
}

// ── Surveillance Camera Overlay ──────────────────────────────
// Queries OSM via Overpass for `man_made=surveillance` / `surveillance:type=camera`
// nodes inside the current viewport. Suppressed at zoom < OVERLAY_MIN_ZOOM.
function CameraOverlay({ enabled }) {
  const map = useMap()
  const layerGroupRef = useRef(null)
  const debounceRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    if (!layerGroupRef.current) {
      layerGroupRef.current = L.layerGroup()
    }
    const layerGroup = layerGroupRef.current

    if (!enabled) {
      if (map.hasLayer(layerGroup)) layerGroup.remove()
      layerGroup.clearLayers()
      return
    }
    if (!map.hasLayer(layerGroup)) layerGroup.addTo(map)

    const fetchAndRender = async () => {
      if (map.getZoom() < OVERLAY_MIN_ZOOM) {
        layerGroup.clearLayers()
        return
      }

      if (abortRef.current) abortRef.current.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const b = map.getBounds()
      const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`
      const query =
        `[out:json][timeout:10];` +
        `(` +
          `node["man_made"="surveillance"](${bbox});` +
          `node["surveillance:type"="camera"](${bbox});` +
        `);` +
        `out tags geom;`

      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: query,
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`Overpass ${res.status}`)
        const json = await res.json()
        const elements = json.elements || []

        layerGroup.clearLayers()
        elements.forEach((el) => {
          if (el.lat == null || el.lon == null) return
          const tags = el.tags || {}
          const camType = tags['camera:type'] || tags['surveillance:type'] || 'camera'
          const operator = tags.operator || tags['surveillance:operator']
          const direction = tags['camera:direction']

          const marker = L.circleMarker([el.lat, el.lon], {
            radius: 4,
            color: '#fbbf24',
            weight: 1.5,
            opacity: 0.95,
            fillColor: '#fbbf24',
            fillOpacity: 0.55,
          })

          const tooltipParts = [camType]
          if (direction) tooltipParts.push(`${direction}°`)
          if (operator) tooltipParts.push(operator)
          marker.bindTooltip(tooltipParts.join(' · '), {
            direction: 'top',
            offset: [0, -4],
            opacity: 0.92,
          })

          layerGroup.addLayer(marker)
        })
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('Camera fetch failed:', err)
        }
      }
    }

    const schedule = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(fetchAndRender, 600)
    }

    fetchAndRender()
    map.on('moveend', schedule)
    map.on('zoomend', schedule)

    return () => {
      map.off('moveend', schedule)
      map.off('zoomend', schedule)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [map, enabled])

  return null
}

// ── Road Intersections Overlay ───────────────────────────────
// Renders OSM-tagged road junctions (signals, stops, crossings, etc.) inside
// the current viewport. Suppressed at zoom < OVERLAY_MIN_ZOOM.
function IntersectionOverlay({ enabled }) {
  const map = useMap()
  const layerGroupRef = useRef(null)
  const debounceRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    if (!layerGroupRef.current) {
      layerGroupRef.current = L.layerGroup()
    }
    const layerGroup = layerGroupRef.current

    if (!enabled) {
      if (map.hasLayer(layerGroup)) layerGroup.remove()
      layerGroup.clearLayers()
      return
    }
    if (!map.hasLayer(layerGroup)) layerGroup.addTo(map)

    const fetchAndRender = async () => {
      if (map.getZoom() < OVERLAY_MIN_ZOOM) {
        layerGroup.clearLayers()
        return
      }

      if (abortRef.current) abortRef.current.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const b = map.getBounds()
      const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`
      const query =
        `[out:json][timeout:10];` +
        `node["highway"~"^(traffic_signals|stop|crossing|give_way|mini_roundabout|turning_circle)$"](${bbox});` +
        `out geom;`

      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: query,
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`Overpass ${res.status}`)
        const json = await res.json()
        const elements = json.elements || []

        layerGroup.clearLayers()
        elements.forEach((el) => {
          if (el.lat == null || el.lon == null) return
          const marker = L.circleMarker([el.lat, el.lon], {
            radius: 3,
            color: '#38bdf8',
            weight: 1.2,
            opacity: 0.9,
            fillColor: '#38bdf8',
            fillOpacity: 0.4,
            interactive: false,
          })
          layerGroup.addLayer(marker)
        })
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('Intersection fetch failed:', err)
        }
      }
    }

    const schedule = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(fetchAndRender, 600)
    }

    fetchAndRender()
    map.on('moveend', schedule)
    map.on('zoomend', schedule)

    return () => {
      map.off('moveend', schedule)
      map.off('zoomend', schedule)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [map, enabled])

  return null
}

// ── Geoman Controls ──────────────────────────────────────────
function getLayerGeometry(layer) {
  if (layer instanceof L.Circle) {
    const ll = layer.getLatLng()
    const r = layer.getRadius()
    return {
      type: 'Point',
      coordinates: [ll.lng, ll.lat],
      radius_metres: r,
      _circle: { center: [ll.lng, ll.lat], radius: r },
    }
  }
  return layer.toGeoJSON().geometry
}

function GeomanControls({ zones, onZoneAdd, onZoneUpdate, onZoneRemove, drawingMode = 'area' }) {
  const map = useMap()
  const layersRef = useRef(new Map()) // zoneId → leaflet layer

  // Reconfigure draw tools when the operator picks a different disaster type.
  // 'area'  → polygon + circle + rectangle (drawn shapes)
  // 'point' → CircleMarker only (single click on the map)
  // 'city'  → no draw tools; editing/removing remain available
  useEffect(() => {
    if (!map.pm) return

    // Cancel any in-progress draft so type-switching doesn't orphan a half-drawn shape.
    if (map.pm.globalDrawModeEnabled?.()) map.pm.disableDraw()

    const isArea = drawingMode === 'area'
    const isPoint = drawingMode === 'point'

    map.pm.addControls({
      position: 'topleft',
      drawCircle: isArea,
      drawRectangle: isArea,
      drawPolygon: isArea,
      drawCircleMarker: isPoint,
      drawMarker: false,
      drawPolyline: false,
      editMode: true,
      dragMode: true,
      cutPolygon: false,
      removalMode: true,
    })

    map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 20,
      allowSelfIntersection: false,
    })
  }, [map, drawingMode])

  // Visually highlight the Geoman toolbar whenever a draw tool is available
  // for the active disaster — operators always know which buttons to use.
  // The CSS animation lives in index.css under `.pm-highlight`.
  useEffect(() => {
    const container = map?.getContainer?.()
    if (!container) return
    const hasDrawTool = drawingMode === 'area' || drawingMode === 'point'
    container.classList.toggle('pm-highlight', hasDrawTool)
    return () => container.classList.remove('pm-highlight')
  }, [map, drawingMode])

  // pm:create / pm:remove wiring, independent of which tool is enabled.
  useEffect(() => {
    if (!map.pm) return

    const handleCreate = ({ layer }) => {
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      layersRef.current.set(id, layer)

      const syncGeometry = () => onZoneUpdate(id, { geometry: getLayerGeometry(layer) })
      layer.on('pm:edit', syncGeometry)
      layer.on('pm:dragend', syncGeometry)

      onZoneAdd({ id, geometry: getLayerGeometry(layer) })
    }

    const handleRemove = ({ layer }) => {
      for (const [id, l] of layersRef.current.entries()) {
        if (l === layer) {
          layersRef.current.delete(id)
          onZoneRemove(id)
          break
        }
      }
    }

    map.on('pm:create', handleCreate)
    map.on('pm:remove', handleRemove)
    return () => {
      map.off('pm:create', handleCreate)
      map.off('pm:remove', handleRemove)
    }
  }, [map, onZoneAdd, onZoneUpdate, onZoneRemove])

  // Reconcile zones → layer styles + removal of orphan layers
  useEffect(() => {
    zones.forEach((z) => {
      const layer = layersRef.current.get(z.id)
      if (layer && layer.setStyle) {
        layer.setStyle({
          color: z.color,
          fillColor: z.color,
          fillOpacity: 0.18,
          weight: 2,
          opacity: 0.95,
        })
      }
    })
    const validIds = new Set(zones.map((z) => z.id))
    for (const [id, layer] of [...layersRef.current.entries()]) {
      if (!validIds.has(id)) {
        if (map.hasLayer(layer)) map.removeLayer(layer)
        layersRef.current.delete(id)
      }
    }
  }, [zones, map])

  return null
}

// ── Main MapView Export ────────────────────────────────────────
export default function MapView({
  zones = [], onZoneAdd, onZoneUpdate, onZoneRemove,
  drawingMode = 'area', mapStyle = 'dark',
  showCameras = false, showIntersections = false,
  city = null, route = null,
  waypoints = { start: null, end: null }, waypointMode = null, onWaypointPick,
  citizenEngine = null, focusPoint = null, onCitizenClick, onCitizenContextMenu,
  // Emergency-services props — fire
  fireStations = [],
  stationPlacementMode = false,
  onStationPlace,
  // Emergency-services props — medical
  hospitals = [],
  hospitalPlacementMode = false,
  onHospitalPlace,
  // Emergency-services props — police
  policeStations = [],
  policePlacementMode = false,
  onPolicePlace,
  notifications = [],
  cordons = [],
  // Fire-truck dispatch
  dispatchTargetMode = false,
  dispatchTarget = null,
  activeDispatches = [],
  onDispatchTargetPick,
  // Ambulance dispatch
  ambDispatchTargetMode = false,
  ambDispatchTarget = null,
  activeAmbulanceDispatches = [],
  onAmbDispatchTargetPick,
  // Police dispatch
  policeDispatchTargetMode = false,
  policeDispatchTarget = null,
  activePoliceDispatches = [],
  onPoliceDispatchTargetPick,
  polygonDrawKind = null, // 'notification' | 'cordon' | null
  onPolygonDraw,
  weatherRegions = [],
  onWeatherBadgeClick,
  // Mock CCTV cameras spawned by the backend around each active zone.
  mockCameras = [],
}) {
  const tileUrls = {
    colored: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  }

  return (
    <MapContainer
      center={[40.78, -73.97]}
      zoom={12}
      minZoom={2}
      className="w-full h-full absolute inset-0 z-0"
      zoomControl={true}
    >
      <TileLayer
        key={mapStyle}
        url={tileUrls[mapStyle] || tileUrls.dark}
        attribution='&copy; OpenStreetMap &copy; CARTO'
        subdomains="abcd"
        maxZoom={20}
        // Keep more tiles loaded outside the viewport so back-pans don't flash
        // empty squares. Paired with the tile-cache service worker, subsequent
        // sessions also load instantly from cache.
        keepBuffer={8}
      />

      <CityBoundsController city={city} />
      <FocusController point={focusPoint} />
      <CameraOverlay enabled={showCameras} />
      <IntersectionOverlay enabled={showIntersections} />
      <MockCameraLayer cameras={mockCameras} />
      {citizenEngine && <WaveLayer engine={citizenEngine} />}
      {citizenEngine && (
        <CitizenLayer
          engine={citizenEngine}
          onCitizenClick={onCitizenClick}
          onCitizenContextMenu={onCitizenContextMenu}
        />
      )}
      <GeomanControls
        zones={zones}
        onZoneAdd={onZoneAdd}
        onZoneUpdate={onZoneUpdate}
        onZoneRemove={onZoneRemove}
        drawingMode={drawingMode}
      />
      <RouteLayer route={route} waypoints={waypoints} />
      <WaypointPicker mode={waypointMode} onPick={onWaypointPick} />
      <FireStationMarkers stations={fireStations} />
      <HospitalMarkers stations={hospitals} />
      <PoliceStationMarkers stations={policeStations} />
      <MobileUsersLayer />
      <StationPlacer mode={stationPlacementMode} onPlace={onStationPlace} />
      <StationPlacer mode={hospitalPlacementMode} onPlace={onHospitalPlace} />
      <StationPlacer mode={policePlacementMode} onPlace={onPolicePlace} />
      <StationPlacer mode={dispatchTargetMode} onPlace={onDispatchTargetPick} />
      <StationPlacer mode={ambDispatchTargetMode} onPlace={onAmbDispatchTargetPick} />
      <StationPlacer mode={policeDispatchTargetMode} onPlace={onPoliceDispatchTargetPick} />
      <DispatchTargetCircle target={dispatchTarget} />
      <DispatchTargetCircle target={ambDispatchTarget} color="#fb7185" />
      <DispatchTargetCircle target={policeDispatchTarget} color="#3b82f6" />
      <ActiveDispatchCircles dispatches={activeDispatches} />
      <ActiveDispatchCircles dispatches={activeAmbulanceDispatches} color="#fb7185" />
      <ActiveDispatchCircles dispatches={activePoliceDispatches} color="#3b82f6" />
      <PolygonOverlay
        items={notifications}
        style={{ color: '#fbbf24', weight: 2, fillColor: '#fbbf24', fillOpacity: 0.15 }}
      />
      <PolygonOverlay
        items={cordons}
        style={{ color: '#f97316', weight: 2, dashArray: '4 6', fillColor: '#f97316', fillOpacity: 0.12 }}
      />
      <PolygonDrawer mode={!!polygonDrawKind} onComplete={onPolygonDraw} />
      <WeatherRegionOverlay regions={weatherRegions} onBadgeClick={onWeatherBadgeClick} />
    </MapContainer>
  )
}
