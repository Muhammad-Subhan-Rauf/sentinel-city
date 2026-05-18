// Direct-canvas citizen overlay.
//
// Earlier versions used L.circleMarker with L.canvas() renderer. That hit two
// Leaflet bugs at 1500 markers: (a) batch setLatLng updates left the canvas's
// _redrawRequest in a stuck state across StrictMode map remounts, so engine
// position updates never repainted, and (b) the marker-pane canvas didn't
// always follow the map's pan/zoom transform cleanly.
//
// This version owns a single <canvas> on a custom pane and draws every dot
// itself on each engine notification. No Leaflet renderer involvement.

import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

const STATE_COLORS = {
  walking: '#9ca3af',
  fleeing: '#ef4444',
  approaching: '#fbbf24',
  hiding: '#a78bfa',
  affected: '#ec4899',
  shelter: '#60a5fa',
  fainted: '#7f1d1d',
}

// Custom pane sits between overlayPane (400, where drawn polygons live) and
// markerPane (600, where icon markers live) so citizens render on top of the
// hazard fill but below operator markers.
const PANE_NAME = 'citizen-canvas'
const PANE_Z = 500

function styleFor(state) {
  if (state === 'affected') return { color: '#ec4899', radius: 4.5, stroke: '#fff', strokeWidth: 1.5 }
  if (state === 'fainted') return { color: '#7f1d1d', radius: 5, stroke: '#fff', strokeWidth: 1.5 }
  return { color: STATE_COLORS[state] || STATE_COLORS.walking, radius: 2.5, stroke: null, strokeWidth: 0 }
}

export default function CitizenLayer({ engine, enabled = true, onCitizenClick }) {
  const map = useMap()
  const onClickRef = useRef(onCitizenClick)
  useEffect(() => { onClickRef.current = onCitizenClick }, [onCitizenClick])

  useEffect(() => {
    if (!engine || !enabled) return

    // Ensure our pane exists. createPane is idempotent if a pane of the same
    // name already exists on this map.
    if (!map.getPane(PANE_NAME)) {
      const p = map.createPane(PANE_NAME)
      p.style.zIndex = String(PANE_Z)
      p.style.pointerEvents = 'auto'
    }
    const pane = map.getPane(PANE_NAME)

    const canvas = L.DomUtil.create('canvas', 'citizen-canvas', pane)
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    const ctx = canvas.getContext('2d')

    const dpr = window.devicePixelRatio || 1

    // Resize + reposition the canvas to overlay the current viewport. Called
    // on map move/zoom/resize. Sets the canvas's CSS transform so the parent
    // pane's leaflet-managed transform plus our offset keeps the canvas
    // aligned with the map regardless of pan state.
    const layout = () => {
      const size = map.getSize()
      const topLeft = map.containerPointToLayerPoint([0, 0])
      canvas.width = Math.round(size.x * dpr)
      canvas.height = Math.round(size.y * dpr)
      canvas.style.width = size.x + 'px'
      canvas.style.height = size.y + 'px'
      L.DomUtil.setPosition(canvas, topLeft)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = () => {
      if (!engine) return
      const snap = engine.snapshot()
      const size = map.getSize()
      ctx.clearRect(0, 0, size.x, size.y)

      // Project once per citizen. layerPointToContainerPoint is fast, but we
      // can save a step by going lat/lng → containerPoint directly.
      const kinds = snap.kind
      for (let i = 0; i < snap.count; i++) {
        const cp = map.latLngToContainerPoint([snap.lats[i], snap.lngs[i]])
        // Skip off-screen dots — saves arc + fill work.
        if (cp.x < -8 || cp.y < -8 || cp.x > size.x + 8 || cp.y > size.y + 8) continue
        // Fire trucks: red square with white outline so they pop against the
        // ambient citizen pool.
        if (kinds && kinds[i] === 1) {
          ctx.fillStyle = '#ef4444'
          ctx.fillRect(cp.x - 4, cp.y - 4, 8, 8)
          ctx.lineWidth = 1
          ctx.strokeStyle = '#fff'
          ctx.strokeRect(cp.x - 4, cp.y - 4, 8, 8)
          continue
        }
        const s = styleFor(snap.states[i])
        ctx.beginPath()
        ctx.arc(cp.x, cp.y, s.radius, 0, Math.PI * 2)
        ctx.fillStyle = s.color
        ctx.fill()
        if (s.stroke) {
          ctx.lineWidth = s.strokeWidth
          ctx.strokeStyle = s.stroke
          ctx.stroke()
        }
      }
    }

    const onMove = () => { layout(); draw() }

    // Hit-test on click: walk citizens, return the closest one within hit
    // tolerance (in screen pixels).
    const HIT_TOLERANCE = 8
    const onClick = (e) => {
      if (!onClickRef.current) return
      // Convert click pageX/pageY to container coords.
      const rect = map.getContainer().getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const snap = engine.snapshot()
      let bestIdx = -1
      let bestDist2 = HIT_TOLERANCE * HIT_TOLERANCE
      for (let i = 0; i < snap.count; i++) {
        const cp = map.latLngToContainerPoint([snap.lats[i], snap.lngs[i]])
        const dx = cp.x - cx, dy = cp.y - cy
        const d2 = dx * dx + dy * dy
        if (d2 < bestDist2) { bestDist2 = d2; bestIdx = i }
      }
      if (bestIdx >= 0) {
        L.DomEvent.stop(e)
        onClickRef.current(bestIdx)
      }
    }

    canvas.addEventListener('click', onClick)
    map.on('move zoom viewreset resize', onMove)

    layout()
    draw()

    const unsubscribe = engine.subscribe(draw)

    return () => {
      unsubscribe()
      map.off('move zoom viewreset resize', onMove)
      canvas.removeEventListener('click', onClick)
      canvas.remove()
    }
  }, [map, engine, enabled])

  return null
}
