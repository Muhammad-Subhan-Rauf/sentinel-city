import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || ''

/**
 * Mock CCTV camera layer. One cyan dot per camera spawned by the backend
 * around an active disaster zone. Click a dot to see the pre-generated
 * disaster image the AI agent would receive from this camera.
 *
 * Distinct from the existing OSM `CameraOverlay` (which pulls real-world
 * `man_made=surveillance` nodes via Overpass and is yellow). These cameras
 * are tied to operator-placed zones and disappear when the zone resolves.
 */
export default function MockCameraLayer({ cameras = [] }) {
  const map = useMap()
  const layerGroupRef = useRef(null)

  useEffect(() => {
    if (!layerGroupRef.current) {
      layerGroupRef.current = L.layerGroup().addTo(map)
    }
    const layerGroup = layerGroupRef.current
    layerGroup.clearLayers()

    cameras.forEach((cam) => {
      const marker = L.circleMarker([cam.lat, cam.lng], {
        radius: 5,
        color: '#22d3ee',
        weight: 2,
        opacity: 0.95,
        fillColor: '#22d3ee',
        fillOpacity: 0.55,
      })

      marker.bindTooltip(
        `CCTV · ${cam.disaster_type.replaceAll('_', ' ')} (sev ${cam.severity})`,
        { direction: 'top', offset: [0, -4], opacity: 0.92 },
      )

      const feedUrl = `${BACKEND_URL}/api/cctv/feed/${cam.id}`
      const popupHtml = `
        <div style="font-family: ui-sans-serif, system-ui; min-width: 220px; max-width: 320px;">
          <div style="font-size: 11px; color: #71717a; margin-bottom: 4px; letter-spacing: 0.04em; text-transform: uppercase;">
            CCTV · ${cam.id}
          </div>
          <div style="font-size: 12px; color: #18181b; margin-bottom: 8px; font-weight: 600;">
            ${cam.disaster_type.replaceAll('_', ' ')} &middot; severity ${cam.severity}
          </div>
          <img src="${feedUrl}"
               alt="CCTV feed for ${cam.disaster_type} sev ${cam.severity}"
               style="width: 100%; border-radius: 4px; display: block; background: #18181b;"
               onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'Feed unavailable',style:'padding:24px;text-align:center;color:#a1a1aa;background:#18181b;border-radius:4px;'}))" />
        </div>
      `
      marker.bindPopup(popupHtml, { maxWidth: 340 })

      layerGroup.addLayer(marker)
    })

    return () => {
      // Don't tear down the layerGroup itself between renders — just clear
      // its children. Lets us re-render markers on every cameras update
      // without flicker.
    }
  }, [map, cameras])

  useEffect(() => {
    // Final unmount cleanup.
    return () => {
      if (layerGroupRef.current) {
        layerGroupRef.current.remove()
        layerGroupRef.current = null
      }
    }
  }, [])

  return null
}
