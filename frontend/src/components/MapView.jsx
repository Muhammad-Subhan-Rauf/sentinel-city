// ============================================================
// MapView.jsx — Leaflet map with Geoman drawing tools & H3 grid
// ============================================================
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'
import { polygonToCells, cellToBoundary } from 'h3-js'

// Fix default marker icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── H3 Hexagonal Grid Overlay ────────────────────────────────
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
      let res = 2
      if (zoom >= 16) res = 9
      else if (zoom >= 14) res = 8
      else if (zoom >= 12) res = 7
      else if (zoom >= 10) res = 6
      else if (zoom >= 8) res = 5
      else if (zoom >= 6) res = 4
      else if (zoom >= 4) res = 3

      const bounds = map.getBounds()
      const nw = bounds.getNorthWest()
      const ne = bounds.getNorthEast()
      const se = bounds.getSouthEast()
      const sw = bounds.getSouthWest()

      const clampLat = lat => Math.max(-89.9, Math.min(89.9, lat))
      let minLng = Math.min(nw.lng, sw.lng)
      let maxLng = Math.max(ne.lng, se.lng)
      if (maxLng - minLng > 350) {
        minLng = -179.9
        maxLng = 179.9
      }

      const poly = [
        [minLng, clampLat(nw.lat)],
        [maxLng, clampLat(ne.lat)],
        [maxLng, clampLat(se.lat)],
        [minLng, clampLat(sw.lat)],
        [minLng, clampLat(nw.lat)],
      ]

      try {
        const cells = polygonToCells([poly], res, true)
        const cappedCells = cells.slice(0, 500)

        cappedCells.forEach(cell => {
          const boundary = cellToBoundary(cell) // [[lat, lng], [lat, lng], ...]
          const polyLayer = L.polygon(boundary, {
            color: '#06b6d4',
            weight: 1.5,
            opacity: 0.7,
            fillColor: '#06b6d4',
            fillOpacity: 0.08,
            interactive: false,
          })
          layerGroup.addLayer(polyLayer)
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
  }, [map, enabled])

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

// ── Main MapView export ────────────────────────────────────────
export default function MapView({ onShapeDrawn, showGrid = true, mapStyle = 'colored' }) {
  const tileUrls = {
    colored: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  }

  return (
    <MapContainer
      center={[25, 10]}
      zoom={3}
      minZoom={2}
      className="w-full h-full"
      zoomControl={true}
    >
      <TileLayer
        key={mapStyle}
        url={tileUrls[mapStyle] || tileUrls.colored}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; CARTO'
        subdomains="abcd"
        maxZoom={20}
      />

      <H3GridControls enabled={showGrid} />
      <GeomanControls onShapeDrawn={onShapeDrawn} />
    </MapContainer>
  )
}
