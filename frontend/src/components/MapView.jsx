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

// ── Geoman Controls ──────────────────────────────────────────
function GeomanControls({ onShapeDrawn }) {
  const map = useMap()
  const drawnLayersRef = useRef([])

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
      drawnLayersRef.current.push(layer)
      const geojson = layer.toGeoJSON()
      const geometry = geojson.geometry

      if (layer instanceof L.Circle) {
        const latlng = layer.getLatLng()
        const radius = layer.getRadius()
        onShapeDrawn({
          type: 'Point',
          coordinates: [latlng.lng, latlng.lat],
          radius_metres: radius,
          _circle: { center: [latlng.lng, latlng.lat], radius },
        })
      } else {
        onShapeDrawn(geometry)
      }
    }

    map.on('pm:create', handleCreate)
    return () => map.off('pm:create', handleCreate)
  }, [map, onShapeDrawn])

  return null
}

// ── Main MapView Export ────────────────────────────────────────
export default function MapView({ onShapeDrawn, showGrid = true, h3Resolution = 3, mapStyle = 'dark' }) {
  const tileUrls = {
    colored: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  }

  return (
    <MapContainer
      center={[35, -20]}
      zoom={4}
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

      <H3GridControls enabled={showGrid} resolution={h3Resolution} mapStyle={mapStyle} />
      <GeomanControls onShapeDrawn={onShapeDrawn} />
    </MapContainer>
  )
}
