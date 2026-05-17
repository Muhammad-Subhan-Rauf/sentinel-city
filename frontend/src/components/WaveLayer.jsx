// Renders the expanding wave front for spreading hazards (Flood, Wildfire).
// One L.Circle per active zone, kept in sync with the engine's wave state on
// every tick notification.

import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

export default function WaveLayer({ engine }) {
  const map = useMap()
  const groupRef = useRef(null)
  const circlesRef = useRef(new Map()) // zoneId → L.Circle

  useEffect(() => {
    if (!engine?.getZoneWaves) return

    if (!groupRef.current) groupRef.current = L.layerGroup()
    const group = groupRef.current
    if (!map.hasLayer(group)) group.addTo(map)

    const applyWaves = () => {
      const waves = engine.getZoneWaves() || []
      const activeIds = new Set()

      for (const w of waves) {
        if (!w.radius || w.radius <= 0) continue
        activeIds.add(w.zoneId)

        // Stroke-only dashed ring so the wave is visually distinct from the
        // operator's drawn polygon fill underneath. Fill would just blend
        // with the polygon and obscure both shapes.
        const style = {
          color: w.color,
          weight: 3,
          opacity: 0.9,
          fillOpacity: 0,
          interactive: false,
          dashArray: '8 6',
        }

        let c = circlesRef.current.get(w.zoneId)
        if (c) {
          c.setLatLng([w.lat, w.lng])
          c.setRadius(w.radius)
          c.setStyle(style)
        } else {
          c = L.circle([w.lat, w.lng], { ...style, radius: w.radius })
          c.addTo(group)
          circlesRef.current.set(w.zoneId, c)
        }
      }

      // Remove circles whose zones are gone or whose radius collapsed to 0.
      for (const [id, c] of [...circlesRef.current.entries()]) {
        if (!activeIds.has(id)) {
          group.removeLayer(c)
          circlesRef.current.delete(id)
        }
      }
    }

    const unsubscribe = engine.subscribe(applyWaves)
    applyWaves()

    return () => {
      unsubscribe()
    }
  }, [map, engine])

  // Final teardown when the layer unmounts (city change, engine swap).
  useEffect(() => {
    return () => {
      if (groupRef.current && map.hasLayer(groupRef.current)) {
        groupRef.current.remove()
      }
      circlesRef.current.clear()
    }
  }, [map])

  return null
}
