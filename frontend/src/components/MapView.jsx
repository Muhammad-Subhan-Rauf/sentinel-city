// ============================================================
// MapView.jsx — Premium Fullscreen Map with Fixed H3 Resolution Grid
// ============================================================
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import { latLngToCell, gridDisk, cellToBoundary, getHexagonEdgeLengthAvg, UNITS } from 'h3-js'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── Precise H3 Hexagonal Grid (Fixed Resolution) ─────────────
const GRID_STYLES = {
  satellite: { color: '#fafafa', weight: 1.1, opacity: 0.85, fillColor: '#fafafa', fillOpacity: 0.06 },
  dark:      { color: '#fafafa', weight: 1.1, opacity: 0.85, fillColor: '#fafafa', fillOpacity: 0.06 },
  colored:   { color: '#3f3f46', weight: 0.6, opacity: 0.55, fillColor: '#3f3f46', fillOpacity: 0.05 },
}

function H3GridControls({ enabled, resolution, mapStyle }) {
  const map = useMap()
  const layerGroupRef = useRef(null)

  useEffect(() => {
    if (!layerGroupRef.current) {
      layerGroupRef.current = L.layerGroup()
    }
    const layerGroup = layerGroupRef.current

    if (enabled) {
      if (!map.hasLayer(layerGroup)) {
        layerGroup.addTo(map)
      }
    } else {
      if (map.hasLayer(layerGroup)) {
        layerGroup.remove()
      }
      return
    }

    const updateGrid = () => {
      if (!enabled) return
      layerGroup.clearLayers()

      const center = map.getCenter()
      const bounds = map.getBounds()
      const hexEdgeM = getHexagonEdgeLengthAvg(resolution, UNITS.m)
      const hexDiameterM = hexEdgeM * 2

      // Hide grid when each hex would project smaller than ~6 CSS pixels —
      // at that point it's visual noise.
      const p1 = map.containerPointToLatLng([0, 0])
      const p2 = map.containerPointToLatLng([1, 0])
      const metersPerPixel = p1.distanceTo(p2)
      if (!metersPerPixel || hexDiameterM / metersPerPixel < 24) return

      const viewportRadiusM = center.distanceTo(bounds.getNorthEast())
      let ringCount = Math.ceil(viewportRadiusM / hexDiameterM) + 1
      ringCount = Math.max(3, Math.min(ringCount, 28))

      try {
        const centerHex = latLngToCell(center.lat, center.lng, resolution)
        const hexDisk = gridDisk(centerHex, ringCount)

        const style = GRID_STYLES[mapStyle] || GRID_STYLES.dark
        hexDisk.forEach(hex => {
          const boundary = cellToBoundary(hex)
          const hexLayer = L.polygon(boundary, { ...style, interactive: false })
          layerGroup.addLayer(hexLayer)
        })
      } catch (err) {
        console.warn('H3 grid calculation info:', err)
      }
    }

    updateGrid()

    map.on('moveend', updateGrid)
    map.on('zoomend', updateGrid)

    return () => {
      map.off('moveend', updateGrid)
      map.off('zoomend', updateGrid)
    }
  }, [map, enabled, resolution, mapStyle])

  return null
}

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

// ── Surveillance Camera Overlay ──────────────────────────────
// Queries OSM via Overpass for `man_made=surveillance` / `surveillance:type=camera`
// nodes inside the current viewport. Only renders when the H3 grid is also
// visible at the current zoom (same 24-px hex threshold).
function CameraOverlay({ enabled, resolution }) {
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
      // Match the H3 grid's visibility gate
      const hexEdgeM = getHexagonEdgeLengthAvg(resolution, UNITS.m)
      const hexDiameterM = hexEdgeM * 2
      const p1 = map.containerPointToLatLng([0, 0])
      const p2 = map.containerPointToLatLng([1, 0])
      const metersPerPixel = p1.distanceTo(p2)
      if (!metersPerPixel || hexDiameterM / metersPerPixel < 24) {
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
  }, [map, enabled, resolution])

  return null
}

// ── Road Intersections Overlay ───────────────────────────────
// Renders OSM-tagged road junctions (signals, stops, crossings, etc.) inside
// the current viewport. Same grid-visibility gate as the camera overlay.
function IntersectionOverlay({ enabled, resolution }) {
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
      const hexEdgeM = getHexagonEdgeLengthAvg(resolution, UNITS.m)
      const hexDiameterM = hexEdgeM * 2
      const p1 = map.containerPointToLatLng([0, 0])
      const p2 = map.containerPointToLatLng([1, 0])
      const metersPerPixel = p1.distanceTo(p2)
      if (!metersPerPixel || hexDiameterM / metersPerPixel < 24) {
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
  }, [map, enabled, resolution])

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

function GeomanControls({ zones, onZoneAdd, onZoneUpdate, onZoneRemove }) {
  const map = useMap()
  const layersRef = useRef(new Map()) // zoneId → leaflet layer

  // Set up draw controls + global event handlers
  useEffect(() => {
    if (!map.pm) return

    map.pm.addControls({
      position: 'topleft',
      drawCircle: true,
      drawCircleMarker: false,
      drawMarker: false,
      drawPolyline: false,
      drawRectangle: true,
      drawPolygon: true,
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
export default function MapView({ zones = [], onZoneAdd, onZoneUpdate, onZoneRemove, showGrid = true, h3Resolution = 3, mapStyle = 'dark', showCameras = false, showIntersections = false, city = null, route = null, waypoints = { start: null, end: null }, waypointMode = null, onWaypointPick }) {
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
      />

      <CityBoundsController city={city} />
      <H3GridControls enabled={showGrid} resolution={h3Resolution} mapStyle={mapStyle} />
      <CameraOverlay enabled={showGrid && showCameras} resolution={h3Resolution} />
      <IntersectionOverlay enabled={showGrid && showIntersections} resolution={h3Resolution} />
      <GeomanControls
        zones={zones}
        onZoneAdd={onZoneAdd}
        onZoneUpdate={onZoneUpdate}
        onZoneRemove={onZoneRemove}
      />
      <RouteLayer route={route} waypoints={waypoints} />
      <WaypointPicker mode={waypointMode} onPick={onWaypointPick} />
    </MapContainer>
  )
}
