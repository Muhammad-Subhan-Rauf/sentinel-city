import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import MapView from './MapView'
import CityPicker from './CityPicker'
import RoutePanel from './RoutePanel'
import CallsDrawer from './CallsDrawer'
import SeveritySelector from './SeveritySelector'
import { requestRoute } from '../lib/routing'
import { loadRoadGraph } from '../lib/roadGraph'
import { createCitizenEngine } from '../sim/citizenEngine'
import {
  DISASTER_TYPES,
  DISASTER_PROFILES,
  getProfile,
  getGeometryMode,
  getAllowedGeometries,
} from '../lib/disasterProfiles'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

const MAP_STYLES = [
  { value: 'dark',      label: 'Dark' },
  { value: 'colored',   label: 'Streets' },
  { value: 'satellite', label: 'Satellite' },
]

// Default operating area on app load. Bounds match the Manhattan admin boundary
// from OSM/Nominatim. The polygon is a hand-traced approximation of the island
// outline so we can filter the road graph to Manhattan-only nodes (the bbox
// alone includes Jersey City, the Bronx edge, and Queens/Brooklyn edges).
const DEFAULT_CITY = {
  id: 'manhattan-default',
  name: 'Manhattan, New York County, New York, United States',
  shortName: 'Manhattan',
  polygon: {
    type: 'Polygon',
    coordinates: [[
      [-73.923, 40.879],  // Inwood north tip
      [-73.911, 40.864],  // Spuyten Duyvil curve
      [-73.928, 40.835],
      [-73.929, 40.810],  // East Harlem
      [-73.937, 40.795],  // East 96th
      [-73.948, 40.781],  // Upper East 80s
      [-73.958, 40.764],  // East 60s
      [-73.965, 40.752],  // Midtown East
      [-73.969, 40.738],  // East 30s
      [-73.972, 40.726],  // East Village
      [-73.971, 40.711],  // Lower East Side
      [-73.999, 40.701],  // Financial District south
      [-74.018, 40.701],  // Battery west
      [-74.014, 40.717],  // Tribeca west
      [-74.011, 40.733],  // West Village
      [-74.010, 40.752],  // Hell's Kitchen
      [-74.001, 40.769],  // West 60s
      [-73.992, 40.781],
      [-73.980, 40.799],  // Upper West Side
      [-73.968, 40.811],  // Morningside Heights
      [-73.953, 40.835],
      [-73.944, 40.849],  // Washington Heights
      [-73.933, 40.864],  // Fort Tryon
      [-73.923, 40.879],  // close
    ]],
  },
  bounds: [
    [40.6815, -74.0479],
    [40.8820, -73.9070],
  ],
}

const now = () => new Date().toLocaleTimeString('en-US', { hour12: false })

export default function DisasterDashboard() {
  const [disasterType, setDisasterType] = useState('Flood')
  const [severity, setSeverity] = useState(3)
  const [notes, setNotes] = useState('')
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(false)
  // Per-type override of the geometry mode, only meaningful for types with
  // multiple allowedGeometries (Power_Outage). Falls back to the profile default.
  const [geometryModeOverrides, setGeometryModeOverrides] = useState({})
  const [showCameras, setShowCameras] = useState(false)
  const [showIntersections, setShowIntersections] = useState(false)
  const [mapStyle, setMapStyle] = useState('colored')
  const [city, setCity] = useState(DEFAULT_CITY) // { id, name, shortName, polygon, bounds } | null

  // Routing state
  const [waypoints, setWaypoints] = useState({ start: null, end: null })
  const [waypointMode, setWaypointMode] = useState(null) // 'start' | 'end' | null
  const [route, setRoute] = useState(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeError, setRouteError] = useState(null)

  const [logOpen, setLogOpen] = useState(true)
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'System ready.' },
  ])

  // Citizen simulation + 911 stream
  const [simStatus, setSimStatus] = useState('Loading street network…')
  const [simReady, setSimReady] = useState(false)
  const [simSpeed, setSimSpeed] = useState(1)
  const [citizenReports, setCitizenReports] = useState([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [callFilter, setCallFilter] = useState('all')
  const [engine, setEngine] = useState(null)
  const zonesRef = useRef(zones)
  const pendingReportsRef = useRef([])

  // Push simSpeed changes into the engine's tick loop.
  useEffect(() => {
    if (!engine) return
    engine.setSpeed(simSpeed)
  }, [engine, simSpeed])

  const addLog = (type, message) =>
    setLog((prev) => [{ type, time: now(), message }, ...prev].slice(0, 80))

  // Resolved geometry mode for the currently-selected type (override wins).
  const activeGeometryMode =
    geometryModeOverrides[disasterType] || getGeometryMode(disasterType)
  const allowedGeometries = getAllowedGeometries(disasterType)

  // Clamp severity into the current type's range whenever the type changes.
  useEffect(() => {
    const p = getProfile(disasterType)
    if (!p) return
    const { min, max } = p.severity
    if (severity < min) setSeverity(min)
    else if (severity > max) setSeverity(max)
  }, [disasterType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Draft values (what the next-drawn zone will inherit) — kept in a ref so
  // the zone-add callback has stable identity and doesn't re-bind Geoman.
  const draftRef = useRef({ disasterType, severity, notes, geometryMode: activeGeometryMode })
  useEffect(() => {
    draftRef.current = { disasterType, severity, notes, geometryMode: activeGeometryMode }
  }, [disasterType, severity, notes, activeGeometryMode])

  // Mirror zones into a ref so the citizen engine (created once) always reads
  // the latest array without re-binding its tick handler.
  useEffect(() => {
    zonesRef.current = zones
  }, [zones])

  // Boot the road graph + citizen engine once on mount (Manhattan bounds).
  useEffect(() => {
    let cancelled = false
    let localEngine = null
    const ctrl = new AbortController()

    ;(async () => {
      try {
        const graph = await loadRoadGraph(DEFAULT_CITY.bounds, {
          signal: ctrl.signal,
          polygon: DEFAULT_CITY.polygon,
          onProgress: (msg) => !cancelled && setSimStatus(msg),
        })
        if (cancelled) return
        const CITIZEN_COUNT = 1500
        localEngine = createCitizenEngine({
          roadGraph: graph,
          count: CITIZEN_COUNT,
          getZones: () => zonesRef.current,
          onReport: (r) => {
            pendingReportsRef.current.push(r)
          },
        })
        localEngine.start()
        setEngine(localEngine)
        setSimReady(true)
        setSimStatus(`${graph.size()} street nodes loaded · ${CITIZEN_COUNT} citizens active.`)
      } catch (err) {
        if (err.name === 'AbortError') return
        console.warn('Citizen sim failed to start:', err)
        setSimStatus(`Sim offline: ${err.message}`)
      }
    })()

    return () => {
      cancelled = true
      ctrl.abort()
      if (localEngine) localEngine.stop()
      setEngine(null)
    }
  }, [])

  // Batched flush of pending reports: append to UI state and POST to backend
  // every 2 s. Keeps the call drawer responsive without spamming the network.
  useEffect(() => {
    const flush = async () => {
      const batch = pendingReportsRef.current
      if (batch.length === 0) return
      pendingReportsRef.current = []

      // Enrich each report with id, reported_at, and the event's type for the UI.
      const zonesNow = zonesRef.current
      const enriched = batch.map((r) => {
        const z = zonesNow.find((z) => z.id === r.event_id)
        return {
          ...r,
          id: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          reported_at: new Date().toISOString(),
          event_type: z?.type,
        }
      })

      setCitizenReports((prev) => {
        const next = [...enriched, ...prev]
        return next.length > 500 ? next.slice(0, 500) : next
      })

      // Fire-and-forget POST. Failures are not fatal; reports remain in UI.
      try {
        await fetch(`${BACKEND_URL}/api/citizen-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reports: batch.map((r) => ({
              event_id: r.event_id,
              citizen_idx: r.citizen_idx,
              report_kind: r.report_kind,
              location: r.location,
              transcript: r.transcript,
              perceived_severity: r.perceived_severity,
            })),
          }),
        })
      } catch {
        /* offline / backend down — drop silently */
      }
    }

    const id = setInterval(flush, 2000)
    return () => clearInterval(id)
  }, [])

  const handleZoneAdd = useCallback(({ id, geometry }) => {
    const d = draftRef.current
    const t = DISASTER_TYPES.find((x) => x.value === d.disasterType) || DISASTER_TYPES[0]
    // Infer geometryKind from the actual geometry produced — Geoman emits
    // 'Point' for marker-points and circles, 'Polygon' for everything else.
    const isPoint = geometry?.type === 'Point' && geometry?.radius_metres == null
    const geometryKind = isPoint ? 'point' : 'area'
    const zone = {
      id,
      type: d.disasterType,
      typeLabel: t.label,
      typeIcon: t.icon,
      color: t.color,
      severity: d.severity,
      notes: d.notes.trim() || null,
      geometry,
      geometryKind,
    }
    setZones((prev) => [...prev, zone])
    setLog((prev) =>
      [{ type: 'info', time: now(), message: `Zone added: ${t.label} (severity ${d.severity}).` }, ...prev].slice(0, 80),
    )
  }, [])

  // City-wide event entry — no Geoman drawing involved. Operator clicks the
  // "Add citywide" button in the sidebar.
  const handleAddCitywideZone = useCallback(() => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `zone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const t = DISASTER_TYPES.find((x) => x.value === disasterType) || DISASTER_TYPES[0]
    const zone = {
      id,
      type: disasterType,
      typeLabel: t.label,
      typeIcon: t.icon,
      color: t.color,
      severity,
      notes: notes.trim() || null,
      geometry: null,
      geometryKind: 'city',
    }
    setZones((prev) => [...prev, zone])
    addLog('info', `Citywide ${t.label} added (severity ${severity}).`)
  }, [disasterType, severity, notes]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleZoneUpdate = useCallback((id, patch) => {
    setZones((prev) => prev.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }, [])

  const handleZoneRemove = useCallback((id) => {
    setZones((prev) => prev.filter((z) => z.id !== id))
    setLog((prev) =>
      [{ type: 'info', time: now(), message: 'Zone removed.' }, ...prev].slice(0, 80),
    )
  }, [])

  // ── Routing handlers ───────────────────────────────────────
  const handleWaypointPick = useCallback((point) => {
    setWaypoints((prev) => {
      if (!waypointMode) return prev
      return { ...prev, [waypointMode]: point }
    })
    setWaypointMode(null)
  }, [waypointMode])

  const handleClearWaypoint = (which) => {
    setWaypoints((prev) => ({ ...prev, [which]: null }))
    setRoute(null)
    setRouteError(null)
  }

  const handleClearAllWaypoints = () => {
    setWaypoints({ start: null, end: null })
    setWaypointMode(null)
    setRoute(null)
    setRouteError(null)
  }

  // Focus target sent to MapView when the user clicks a 911 report row.
  // MapView clears its own internal "focus" once it has panned.
  const [focusPoint, setFocusPoint] = useState(null)
  const handleReportClick = useCallback((r) => {
    if (r?.location) {
      setFocusPoint({ lat: r.location.lat, lng: r.location.lng, t: Date.now() })
    }
  }, [])

  const typeIconLookup = useMemo(() => {
    const lookup = new Map(DISASTER_TYPES.map((d) => [d.value, d.icon]))
    return (t) => lookup.get(t) || ''
  }, [])

  // Citizen inspector: click a dot on the map → capture its stats so we can
  // figure out why a particular citizen isn't behaving as expected.
  const [inspectedCitizen, setInspectedCitizen] = useState(null)
  const handleCitizenClick = useCallback((idx) => {
    if (!engine) return
    const stats = engine.getCitizenStats?.(idx)
    if (!stats) return
    setInspectedCitizen(stats)
    // Also dump to console for copy-paste / longer inspection.
    // eslint-disable-next-line no-console
    console.log('[Citizen]', stats)
  }, [engine])

  // Recompute the route whenever waypoints or avoid-zones change.
  useEffect(() => {
    if (!waypoints.start || !waypoints.end) {
      setRoute(null)
      setRouteError(null)
      return
    }
    const ctrl = new AbortController()
    setRouteLoading(true)
    setRouteError(null)
    requestRoute({
      start: waypoints.start,
      end: waypoints.end,
      zones,
      signal: ctrl.signal,
    })
      .then((r) => {
        setRoute(r)
        setRouteError(null)
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setRoute(null)
        setRouteError(err.message)
      })
      .finally(() => setRouteLoading(false))

    return () => ctrl.abort()
  }, [waypoints.start, waypoints.end, zones])

  const handleCitySelect = (c) => {
    setCity(c)
    setZones([])
    addLog('info', `Operating area: ${c.shortName}`)
  }

  const handleCityClear = () => {
    if (city?.id === DEFAULT_CITY.id) return
    addLog('info', `Reset to default area: ${DEFAULT_CITY.shortName}`)
    setCity(DEFAULT_CITY)
    setZones([])
  }

  const currentDisaster = DISASTER_TYPES.find((d) => d.value === disasterType) || DISASTER_TYPES[0]

  const handleTrigger = async () => {
    if (zones.length === 0) {
      addLog('error', 'Draw at least one zone on the map first.')
      return
    }
    setLoading(true)
    addLog('pending', `Submitting ${zones.length} zone${zones.length === 1 ? '' : 's'}…`)

    const failed = []
    for (const zone of zones) {
      try {
        const res = await fetch(`${BACKEND_URL}/api/trigger-disaster`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            disaster_type: zone.type,
            severity: zone.severity,
            geometry: zone.geometry,
            geometry_kind: zone.geometryKind,
            notes: zone.notes,
          }),
        })
        const result = await res.json()
        if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`)
        const shortId = String(result.event_id || '').slice(0, 8)
        addLog('success', `Event ${shortId} (${zone.typeLabel}) recorded`)
      } catch (err) {
        failed.push(zone)
        addLog('error', `${zone.typeLabel}: ${err.message}`)
      }
    }
    setZones(failed)
    setLoading(false)
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-100">
      {/* ─── Sidebar ─────────────────────────────────────────── */}
      <aside className="w-[360px] shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col">
        <header className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Sentinel-City</h1>
            <p className="text-[11px] text-zinc-500 mt-0.5">Municipal emergency orchestration</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Online
          </span>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          {/* Operating area */}
          <section>
            <SectionLabel>Operating area</SectionLabel>
            <CityPicker
              value={city}
              onSelect={handleCitySelect}
              onClear={handleCityClear}
            />
            {!city && (
              <p className="text-[11px] text-zinc-600 mt-1.5 leading-snug">
                Optional — scope the map to a specific city, or leave empty for global view.
              </p>
            )}
          </section>

          {/* Disaster type */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Emergency classification</SectionLabel>
              <span className="text-[10px] text-zinc-600">for next zone</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {DISASTER_TYPES.map((d) => {
                const sel = disasterType === d.value
                return (
                  <button
                    key={d.value}
                    onClick={() => setDisasterType(d.value)}
                    className={[
                      'flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[12px] transition-colors font-medium',
                      sel
                        ? 'bg-zinc-800 border border-zinc-700 text-zinc-100'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                    ].join(' ')}
                  >
                    <span className="text-base leading-none shrink-0">{d.icon}</span>
                    <span className="truncate flex-1">{d.label}</span>
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: d.color, boxShadow: sel ? `0 0 6px ${d.color}` : 'none' }}
                    />
                  </button>
                )
              })}
            </div>
          </section>

          {/* Severity (type-aware) */}
          <SeveritySelector
            type={disasterType}
            value={severity}
            onChange={setSeverity}
          />

          {/* Geometry mode toggle — only shown for types with multiple allowed
              geometries (currently Power_Outage). */}
          {allowedGeometries.length > 1 && (
            <section>
              <SectionLabel>Scope</SectionLabel>
              <div className="inline-flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                {allowedGeometries.map((g) => {
                  const sel = activeGeometryMode === g
                  return (
                    <button
                      key={g}
                      onClick={() =>
                        setGeometryModeOverrides((prev) => ({ ...prev, [disasterType]: g }))
                      }
                      className={[
                        'px-2.5 py-1 text-[11px] rounded transition-colors',
                        sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                      ].join(' ')}
                    >
                      {g === 'city' ? 'Citywide' : g === 'area' ? 'Area' : 'Point'}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {/* Notes */}
          <section>
            <SectionLabel>
              Directives <span className="text-zinc-600 font-normal">(optional)</span>
            </SectionLabel>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Evacuation routes, hazmat details, road units…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-zinc-600 transition-colors"
            />
          </section>

          {/* Zones */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Zones</SectionLabel>
              <span className="text-[11px] text-zinc-500 tabular-nums">{zones.length}</span>
            </div>

            {/* Mode-specific entry hint / action */}
            {activeGeometryMode === 'city' ? (
              <button
                onClick={handleAddCitywideZone}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-dashed border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[12px] text-zinc-200 transition-colors mb-2"
              >
                <span>+</span>
                Add citywide {currentDisaster.label}
              </button>
            ) : activeGeometryMode === 'point' ? (
              <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug mb-2">
                Click once on the map to mark a {currentDisaster.label.toLowerCase()} location.
              </div>
            ) : (
              <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug mb-2">
                Use the drawing tools (top-left) to outline the {currentDisaster.label.toLowerCase()} area.
              </div>
            )}

            {zones.length === 0 ? (
              <div className="px-3 py-2.5 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug">
                No active zones yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {zones.map((z) => {
                  const kindLabel =
                    z.geometryKind === 'city'
                      ? 'Citywide'
                      : z.geometryKind === 'point'
                        ? 'Point'
                        : z.geometry?.type === 'Point'
                          ? 'Circle'
                          : 'Polygon'
                  return (
                    <div
                      key={z.id}
                      className="flex items-center gap-2.5 pl-2 pr-1.5 py-2 rounded-md border border-zinc-800 bg-zinc-900"
                    >
                      <span
                        className="w-1 h-8 rounded-full shrink-0"
                        style={{ background: z.color }}
                      />
                      <span className="text-base leading-none shrink-0">{z.typeIcon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-zinc-200 truncate font-medium">
                          {z.typeLabel}
                        </div>
                        <div className="text-[10px] text-zinc-500 tabular-nums">
                          Sev {z.severity} · {kindLabel}
                        </div>
                      </div>
                      <button
                        onClick={() => handleZoneRemove(z.id)}
                        className="text-zinc-600 hover:text-red-400 text-[16px] leading-none w-6 h-6 flex items-center justify-center rounded transition-colors"
                        title="Remove zone"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Trigger */}
          <button
            id="btn-trigger-disaster"
            onClick={handleTrigger}
            disabled={loading || zones.length === 0}
            className="w-full py-2.5 rounded-md font-medium text-[13px] text-white bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Submitting…
              </span>
            ) : zones.length === 0 ? (
              'Draw at least one zone'
            ) : (
              `Trigger ${zones.length} zone${zones.length === 1 ? '' : 's'}`
            )}
          </button>

          {/* Routing */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel className="mb-0">Routing</SectionLabel>
              <span className="text-[10px] text-zinc-600">avoids active zones</span>
            </div>
            <RoutePanel
              waypoints={waypoints}
              waypointMode={waypointMode}
              onPickMode={setWaypointMode}
              onClearWaypoint={handleClearWaypoint}
              onClearAll={handleClearAllWaypoints}
              route={route}
              loading={routeLoading}
              error={routeError}
            />
          </section>
        </div>

        {/* Activity log */}
        <div className="border-t border-zinc-800">
          <button
            onClick={() => setLogOpen((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-3 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span className="font-medium">Activity</span>
            <span className="text-zinc-600 text-[10px]">{logOpen ? '▾' : '▸'}</span>
          </button>
          {logOpen && (
            <div className="max-h-[180px] overflow-y-auto px-5 pb-4 space-y-1.5">
              {log.map((e, i) => (
                <LogRow key={i} entry={e} />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ─── Map ─────────────────────────────────────────────── */}
      <main className="flex-1 relative">
        <MapView
          zones={zones}
          onZoneAdd={handleZoneAdd}
          onZoneUpdate={handleZoneUpdate}
          onZoneRemove={handleZoneRemove}
          drawingMode={activeGeometryMode}
          mapStyle={mapStyle}
          showCameras={showCameras}
          showIntersections={showIntersections}
          city={city}
          route={route}
          waypoints={waypoints}
          waypointMode={waypointMode}
          onWaypointPick={handleWaypointPick}
          citizenEngine={engine}
          focusPoint={focusPoint}
          onCitizenClick={handleCitizenClick}
        />

        <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2">
          <Segmented value={mapStyle} onChange={setMapStyle} options={MAP_STYLES} />

          <button
            onClick={() => setShowCameras((c) => !c)}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              showCameras
                ? 'text-zinc-100 hover:border-zinc-700'
                : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showCameras ? 'bg-amber-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Cameras {showCameras ? 'on' : 'off'}
          </button>

          <button
            onClick={() => setShowIntersections((v) => !v)}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              showIntersections
                ? 'text-zinc-100 hover:border-zinc-700'
                : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showIntersections ? 'bg-sky-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Intersections {showIntersections ? 'on' : 'off'}
          </button>
        </div>

        {/* Citizen inspector — appears when a dot is clicked on the map */}
        {inspectedCitizen && (
          <div className="absolute top-4 left-16 z-40 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-md text-[11px] text-zinc-200 w-[280px] font-mono">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <span className="font-semibold text-zinc-100">Citizen #{inspectedCitizen.idx}</span>
              <button
                onClick={() => setInspectedCitizen(null)}
                className="text-zinc-500 hover:text-zinc-200 text-[14px] leading-none"
              >
                ×
              </button>
            </div>
            <div className="px-3 py-2 space-y-0.5 leading-relaxed">
              <div><span className="text-zinc-500">state</span> <span className="text-zinc-100">{inspectedCitizen.state}</span> <span className="text-zinc-500">({inspectedCitizen.speed} m/s)</span></div>
              <div><span className="text-zinc-500">pos</span> {inspectedCitizen.lat.toFixed(5)}, {inspectedCitizen.lng.toFixed(5)}</div>
              <div><span className="text-zinc-500">node</span> {String(inspectedCitizen.currentNode).slice(0, 18)}</div>
              <div><span className="text-zinc-500">→ target</span> {String(inspectedCitizen.targetNode).slice(0, 18)}</div>
              <div><span className="text-zinc-500">path</span> {inspectedCitizen.pathLength} nodes, {Math.round(inspectedCitizen.pathRemainingM)} m left</div>
              <div><span className="text-zinc-500">nbrs</span> {inspectedCitizen.neighborCount}</div>
              <div className="pt-1 border-t border-zinc-800 mt-1" />
              <div><span className="text-zinc-500">total moved</span> {Math.round(inspectedCitizen.totalMovedM)} m</div>
              <div>
                <span className="text-zinc-500">last moved</span>{' '}
                <span className={inspectedCitizen.ticksStillSinceMove > 2 ? 'text-amber-400' : 'text-zinc-100'}>
                  {inspectedCitizen.lastMovedSimT > 0
                    ? `t=${inspectedCitizen.lastMovedSimT.toFixed(1)} (Δ${inspectedCitizen.ticksStillSinceMove.toFixed(1)}s ago)`
                    : 'never'}
                </span>
              </div>
              <div><span className="text-zinc-500">retargets</span> {inspectedCitizen.retargetCount} <span className="text-zinc-500">· last at</span> t={inspectedCitizen.lastRetargetSimT.toFixed(1)}</div>
              <div className="pt-1 border-t border-zinc-800 mt-1" />
              <div><span className="text-zinc-500">cause zone</span> {inspectedCitizen.causeZoneId ? String(inspectedCitizen.causeZoneId).slice(0, 12) + '…' : '—'}</div>
              <div><span className="text-zinc-500">state expires</span> {inspectedCitizen.stateExpiresAt === Infinity ? '∞' : inspectedCitizen.stateExpiresAt.toFixed(1)}</div>
              <div><span className="text-zinc-500">recovery at</span> {inspectedCitizen.recoveryAt > 0 ? inspectedCitizen.recoveryAt.toFixed(1) : '—'}</div>
              <div><span className="text-zinc-500">sim time</span> {inspectedCitizen.simTimeS.toFixed(1)}</div>
              <div><span className="text-zinc-500">reports logged</span> {inspectedCitizen.reportLogSize}</div>
            </div>
            <div className="px-3 pb-2 pt-1 text-[10px] text-zinc-600 border-t border-zinc-800">
              snapshot at click — not live. click again to refresh.
            </div>
          </div>
        )}

        {/* Sim status + speed slider (bottom-left of map area) */}
        <div className="absolute bottom-4 left-4 z-30 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-2 text-[11px] text-zinc-400 min-w-[260px]">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={[
                'w-1.5 h-1.5 rounded-full shrink-0',
                simReady ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse',
              ].join(' ')}
            />
            <span className="truncate">{simStatus}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 shrink-0 w-10">Speed</span>
            <input
              type="range"
              min={0}
              max={8}
              step={0.5}
              value={simSpeed}
              onChange={(e) => setSimSpeed(Number(e.target.value))}
              disabled={!simReady}
              className="flex-1"
              style={{
                '--range-pct': `${(simSpeed / 8) * 100}%`,
                '--range-color': simSpeed === 0 ? '#71717a' : '#fafafa',
              }}
            />
            <span className="text-[10px] text-zinc-300 tabular-nums w-12 text-right shrink-0">
              {simSpeed === 0 ? 'Paused' : `${simSpeed}×`}
            </span>
          </div>
        </div>

        {/* Floating 911 calls button */}
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          className={[
            'absolute bottom-4 right-4 z-40 inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-medium transition-colors',
            'bg-zinc-900/95 backdrop-blur border border-zinc-800 text-zinc-100 hover:border-zinc-600 shadow-lg shadow-black/50',
            drawerOpen ? 'ring-2 ring-amber-500/60' : '',
          ].join(' ')}
          title={drawerOpen ? 'Close 911 calls' : 'Open 911 calls'}
        >
          <span className="text-base leading-none">📞</span>
          <span className="tabular-nums">{citizenReports.length}</span>
          <span className="text-zinc-500">calls</span>
        </button>

        <CallsDrawer
          open={drawerOpen}
          reports={citizenReports}
          filter={callFilter}
          onFilterChange={setCallFilter}
          onClose={() => setDrawerOpen(false)}
          onClear={() => setCitizenReports([])}
          onReportClick={handleReportClick}
          typeIconLookup={typeIconLookup}
        />
      </main>
    </div>
  )
}

function SectionLabel({ children, className = '' }) {
  return (
    <h2 className={`text-[12px] font-medium text-zinc-300 mb-2.5 ${className}`}>
      {children}
    </h2>
  )
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex items-center bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md p-0.5">
      {options.map((o) => {
        const sel = value === o.value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={[
              'px-2.5 py-1 text-[12px] rounded transition-colors',
              sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function LogRow({ entry }) {
  const dot =
    {
      success: 'bg-emerald-500',
      error: 'bg-red-500',
      info: 'bg-zinc-500',
      pending: 'bg-amber-500',
    }[entry.type] || 'bg-zinc-500'

  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed">
      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dot}`} />
      <span className="font-mono text-zinc-600 shrink-0">{entry.time}</span>
      <span className="text-zinc-300 break-words">{entry.message}</span>
    </div>
  )
}
