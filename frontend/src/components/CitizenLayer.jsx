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
  dead: '#4b5563',
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

// Blend a hex colour toward near-black as HP drops from 100 → 0. Pure
// linear RGB interpolation; produces a visible "dying" shade without
// needing a separate UI element.
function blendTowardDeath(hex, hp) {
  if (hp >= 100) return hex
  if (hp <= 0) return '#1f2937'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // Target near-black (#1f2937 = 31, 41, 55).
  const t = 1 - hp / 100
  const nr = Math.round(r + (31 - r) * t)
  const ng = Math.round(g + (41 - g) * t)
  const nb = Math.round(b + (55 - b) * t)
  return `rgb(${nr},${ng},${nb})`
}

export default function CitizenLayer({ engine, enabled = true, onCitizenClick, onCitizenContextMenu }) {
  const map = useMap()
  const onClickRef = useRef(onCitizenClick)
  const onContextRef = useRef(onCitizenContextMenu)
  useEffect(() => { onClickRef.current = onCitizenClick }, [onCitizenClick])
  useEffect(() => { onContextRef.current = onCitizenContextMenu }, [onCitizenContextMenu])

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
      const states = snap.states
      const healthArr = snap.health
      const hiddenArr = snap.hidden
      for (let i = 0; i < snap.count; i++) {
        const lat = snap.lats[i], lng = snap.lngs[i]
        // Despawned slots get NaN positions — skip them or Leaflet throws and
        // aborts the rest of the frame, freezing all later entities on screen.
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        if (hiddenArr && hiddenArr[i]) continue  // loaded in an ambulance
        const cp = map.latLngToContainerPoint([lat, lng])
        // Skip off-screen dots — saves arc + fill work.
        if (cp.x < -8 || cp.y < -8 || cp.x > size.x + 8 || cp.y > size.y + 8) continue
        const k = kinds ? kinds[i] : 0
        // Fire trucks: coloured square keyed off the truck-pseudo-state so
        // the operator can tell driving / patrolling / extinguishing apart at
        // a glance.
        if (k === 1) {
          const ts = states[i]
          ctx.fillStyle =
            ts === 'truck_extinguishing' ? '#22c55e' :  // green — fighting
            ts === 'truck_patrolling'    ? '#fbbf24' :  // amber — searching
            '#ef4444'                                    // red — driving
          ctx.fillRect(cp.x - 4, cp.y - 4, 8, 8)
          ctx.lineWidth = 1
          ctx.strokeStyle = '#fff'
          ctx.strokeRect(cp.x - 4, cp.y - 4, 8, 8)
          continue
        }
        // Ambulances: white square with red cross. Loading flashes yellow;
        // transporting inverts (red square, white cross).
        if (k === 2) {
          const ts = states[i]
          const transporting = ts === 'amb_transporting'
          const loading = ts === 'amb_loading'
          const fill = loading ? '#fde047' : transporting ? '#ef4444' : '#ffffff'
          const crossColor = transporting ? '#ffffff' : '#ef4444'
          ctx.fillStyle = fill
          ctx.fillRect(cp.x - 5, cp.y - 5, 10, 10)
          ctx.lineWidth = 1
          ctx.strokeStyle = '#374151'
          ctx.strokeRect(cp.x - 5, cp.y - 5, 10, 10)
          // Cross
          ctx.strokeStyle = crossColor
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(cp.x - 3, cp.y)
          ctx.lineTo(cp.x + 3, cp.y)
          ctx.moveTo(cp.x, cp.y - 3)
          ctx.lineTo(cp.x, cp.y + 3)
          ctx.stroke()
          continue
        }
        // Police: blue square in normal modes; bright yellow with a passenger
        // dot while arresting (transporting a suspect); amber while
        // responding to a reported crime scene.
        if (k === 3) {
          const ts = states[i]
          if (ts === 'police_arresting') {
            // Larger yellow square with a black passenger dot, plus a flashing
            // outline for visibility at distance. "Cop has someone in the car."
            const flash = (Math.floor(Date.now() / 400) % 2) === 0
            ctx.fillStyle = '#facc15'  // bright yellow
            ctx.fillRect(cp.x - 5, cp.y - 5, 10, 10)
            ctx.lineWidth = 2
            ctx.strokeStyle = flash ? '#ef4444' : '#1d4ed8'  // pulses red/blue (lights)
            ctx.strokeRect(cp.x - 5, cp.y - 5, 10, 10)
            // Passenger dot
            ctx.beginPath()
            ctx.arc(cp.x, cp.y, 1.5, 0, Math.PI * 2)
            ctx.fillStyle = '#111827'
            ctx.fill()
          } else if (ts === 'police_responding') {
            // Amber/orange to signal "en route to call".
            ctx.fillStyle = '#f59e0b'
            ctx.fillRect(cp.x - 4, cp.y - 4, 8, 8)
            ctx.lineWidth = 1
            ctx.strokeStyle = '#fff'
            ctx.strokeRect(cp.x - 4, cp.y - 4, 8, 8)
          } else {
            ctx.fillStyle = ts === 'police_patrolling' ? '#3b82f6' : '#1d4ed8'
            ctx.fillRect(cp.x - 4, cp.y - 4, 8, 8)
            ctx.lineWidth = 1
            ctx.strokeStyle = '#fff'
            ctx.strokeRect(cp.x - 4, cp.y - 4, 8, 8)
          }
          continue
        }
        // Arrested citizens — should always be hidden (the engine sets
        // hidden=1 at catch time), but defensive-skip in case any code path
        // sets the state without the flag.
        if (states[i] === 'arrested') continue
        // Dead citizens: gray X.
        if (states[i] === 'dead') {
          ctx.strokeStyle = '#4b5563'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(cp.x - 3, cp.y - 3)
          ctx.lineTo(cp.x + 3, cp.y + 3)
          ctx.moveTo(cp.x + 3, cp.y - 3)
          ctx.lineTo(cp.x - 3, cp.y + 3)
          ctx.stroke()
          continue
        }
        const s = styleFor(states[i])
        // Color gradient on injured dots: blend toward near-black as HP drops.
        const hp = healthArr ? healthArr[i] : 100
        const isInjured = states[i] === 'affected' || states[i] === 'fainted'
        const fillColor = isInjured ? blendTowardDeath(s.color, hp) : s.color
        ctx.beginPath()
        ctx.arc(cp.x, cp.y, s.radius, 0, Math.PI * 2)
        ctx.fillStyle = fillColor
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
        const lat = snap.lats[i], lng = snap.lngs[i]
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        const cp = map.latLngToContainerPoint([lat, lng])
        const dx = cp.x - cx, dy = cp.y - cy
        const d2 = dx * dx + dy * dy
        if (d2 < bestDist2) { bestDist2 = d2; bestIdx = i }
      }
      if (bestIdx >= 0) {
        L.DomEvent.stop(e)
        onClickRef.current(bestIdx)
      }
    }

    // Right-click → operator triggers a robbery on the clicked citizen.
    // Same hit-test as left click; suppress the browser context menu.
    const onContext = (e) => {
      if (!onContextRef.current) return
      const rect = map.getContainer().getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const snap = engine.snapshot()
      const kinds = snap.kind
      let bestIdx = -1
      let bestDist2 = HIT_TOLERANCE * HIT_TOLERANCE
      for (let i = 0; i < snap.count; i++) {
        // Only citizens (kind === 0) are robbable.
        if (kinds && kinds[i] !== 0) continue
        const lat = snap.lats[i], lng = snap.lngs[i]
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        const cp = map.latLngToContainerPoint([lat, lng])
        const dx = cp.x - cx, dy = cp.y - cy
        const d2 = dx * dx + dy * dy
        if (d2 < bestDist2) { bestDist2 = d2; bestIdx = i }
      }
      if (bestIdx >= 0) {
        e.preventDefault()
        L.DomEvent.stop(e)
        onContextRef.current(bestIdx, e.clientX, e.clientY)
      }
    }

    canvas.addEventListener('click', onClick)
    canvas.addEventListener('contextmenu', onContext)
    map.on('move zoom viewreset resize', onMove)

    layout()
    draw()

    const unsubscribe = engine.subscribe(draw)

    return () => {
      unsubscribe()
      map.off('move zoom viewreset resize', onMove)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.remove()
    }
  }, [map, engine, enabled])

  return null
}
