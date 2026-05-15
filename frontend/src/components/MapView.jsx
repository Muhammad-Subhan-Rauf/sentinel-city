// ============================================================
// MapView.jsx — Premium Fullscreen Map with Precise H3 Hex Grid
// ============================================================
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import { latLngToCell, disk, cellToBoundary } from 'h3-js'

// Fix default marker icon paths
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── Precise H3 Hexagonal Grid (Centered around viewport) ─────
function H3GridControls({ enabled }) {
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

      const zoom = map.getZoom()
      // Scale H3 resolution smoothly with map zoom
      let res = 2
      let ringRadius = 5
      if (zoom >= 16) { res = 9; ringRadius = 15 }
      else if (zoom >= 14) { res = 8; ringRadius = 15 }
      else if (zoom >= 12) { res = 7; ringRadius = 12 }
      else if (zoom >= 10) { res = 6; ringRadius = 10 }
      else if (zoom >= 8) { res = 5; ringRadius = 8 }
      else if (zoom >= 6) { res = 4; ringRadius = 6 }
      else if (zoom >= 4) { res = 3; ringRadius = 5 }

      const center = map.getCenter()
      try {
        // Get the center H3 index
        const centerHex = latLngToCell(center.lat, center.lng, res)
        // Get a perfect grid disk of hexagons around the viewport center
        const hexDisk = disk(centerHex, ringRadius)

        hexDisk.forEach(hex => {
          const boundary = cellToBoundary(hex)
          const hexLayer = L.polygon(boundary, {
            color: '#00f2fe',
            weight: 1.5,
            opacity: 0.45,
            fillColor: '#00f2fe',
            fillOpacity: 0.04,
            interactive: false,
          })
          layerGroup.addLayer(hexLayer)
        })
      } catch (err) {
        console.warn('H3 hex grid generation info:', err)
      }
    }

    updateGrid()

    map.on('moveend', updateGrid)
    map.on('zoomend', updateGrid)

    return () => {
      map.off('moveend', updateGrid)
      map.off('zoomend', updateGrid)
    }
  }, [map, enabled])

  return null
}

// ── Geoman Controls (positioned perfectly away from UI) ──────
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
export default function MapView({ onShapeDrawn, showGrid = true, mapStyle = 'dark' }) {
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

      <H3GridControls enabled={showGrid} />
      <GeomanControls onShapeDrawn={onShapeDrawn} />
    </MapContainer>
  )
}
