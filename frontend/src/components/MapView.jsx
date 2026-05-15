// ============================================================
// MapView.jsx — Leaflet map with Geoman drawing tools
// ============================================================
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import '@geoman-io/leaflet-geoman-free'

// Fix default marker icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── Inner component that accesses the map context ────────────
function GeomanControls({ onShapeDrawn }) {
  const map = useMap()
  const drawnLayersRef = useRef([])

  useEffect(() => {
    if (!map.pm) return

    // Initialize Geoman toolbar
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

    // Global options: dark theme integration
    map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 20,
      allowSelfIntersection: false,
    })

    const handleCreate = ({ layer }) => {
      drawnLayersRef.current.push(layer)

      // Extract GeoJSON from drawn shape
      const geojson = layer.toGeoJSON()
      const geometry = geojson.geometry

      // For circles, Leaflet doesn't natively produce GeoJSON circles —
      // we convert to a Point + radius properties.
      if (layer instanceof L.Circle) {
        const latlng = layer.getLatLng()
        const radius = layer.getRadius() // metres
        onShapeDrawn({
          type: 'Point',
          coordinates: [latlng.lng, latlng.lat],
          radius_metres: radius,
          // Also encode as a Polygon approximation for PostGIS compatibility
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
export default function MapView({ onShapeDrawn }) {
  return (
    <MapContainer
      center={[20, 0]}
      zoom={3}
      minZoom={2}
      className="w-full h-full"
      zoomControl={true}
    >
      {/* Dark satellite-style tile layer */}
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
        subdomains="abcd"
        maxZoom={20}
      />

      <GeomanControls onShapeDrawn={onShapeDrawn} />
    </MapContainer>
  )
}
