// ============================================================
// MapView.jsx — Fullscreen Map with disaster zones, routing, and overlays
// ============================================================
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import CitizenLayer from './CitizenLayer'
import WaveLayer from './WaveLayer'

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
export default function MapView({ zones = [], onZoneAdd, onZoneUpdate, onZoneRemove, drawingMode = 'area', mapStyle = 'dark', showCameras = false, showIntersections = false, city = null, route = null, waypoints = { start: null, end: null }, waypointMode = null, onWaypointPick, citizenEngine = null, focusPoint = null, onCitizenClick }) {
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
      {citizenEngine && <WaveLayer engine={citizenEngine} />}
      {citizenEngine && <CitizenLayer engine={citizenEngine} onCitizenClick={onCitizenClick} />}
      <GeomanControls
        zones={zones}
        onZoneAdd={onZoneAdd}
        onZoneUpdate={onZoneUpdate}
        onZoneRemove={onZoneRemove}
        drawingMode={drawingMode}
      />
      <RouteLayer route={route} waypoints={waypoints} />
      <WaypointPicker mode={waypointMode} onPick={onWaypointPick} />
    </MapContainer>
  )
}
