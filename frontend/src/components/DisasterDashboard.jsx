import { useState, useCallback, useEffect, useRef } from 'react'
import MapView from './MapView'
import CityPicker from './CityPicker'
import RoutePanel from './RoutePanel'
import { requestRoute } from '../lib/routing'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

const DISASTER_TYPES = [
  { value: 'Flood',                  label: 'Flood',                  icon: '🌊', color: '#3b82f6' },
  { value: 'Wildfire',               label: 'Wildfire',               icon: '🔥', color: '#ef4444' },
  { value: 'Infrastructure_Failure', label: 'Infrastructure Failure', icon: '🏗️', color: '#a78bfa' },
  { value: 'Robbery',                label: 'Robbery',                icon: '💰', color: '#f59e0b' },
  { value: 'Gang_Violence',          label: 'Gang Violence',          icon: '⚔️', color: '#ec4899' },
  { value: 'Road_Blockage',          label: 'Road Blockage',          icon: '🚧', color: '#f97316' },
  { value: 'Accident',               label: 'Accident',               icon: '💥', color: '#fb923c' },
  { value: 'Heatwave',               label: 'Heatwave',               icon: '☀️', color: '#fbbf24' },
  { value: 'Power_Outage',           label: 'Power Outage',           icon: '⚡', color: '#14b8a6' },
]

const MAP_STYLES = [
  { value: 'dark',      label: 'Dark' },
  { value: 'colored',   label: 'Streets' },
  { value: 'satellite', label: 'Satellite' },
]

// H3 hex sizes (≈ 2 × avg edge length). H3 cells only exist at these discrete
// resolutions, ordered small → large.
const H3_LEVELS = [
  { res: 10, label: '130m' },
  { res: 9,  label: '350m' },
  { res: 8,  label: '920m' },
  { res: 7,  label: '2.4km' },
]

// Default operating area on app load. Bounds match the Manhattan admin boundary
// from OSM/Nominatim.
const DEFAULT_CITY = {
  id: 'manhattan-default',
  name: 'Manhattan, New York County, New York, United States',
  shortName: 'Manhattan',
  polygon: null,
  bounds: [
    [40.6815, -74.0479],
    [40.8820, -73.9070],
  ],
}

const severityLabel = (s) =>
  s <= 2 ? 'Minor'
  : s <= 4 ? 'Moderate'
  : s <= 6 ? 'Significant'
  : s <= 8 ? 'Severe'
  : 'Catastrophic'

const severityColor = (s) =>
  s <= 3 ? '#10b981'    // emerald
  : s <= 5 ? '#eab308'  // yellow
  : s <= 7 ? '#f97316'  // orange
  : s <= 9 ? '#ef4444'  // red
  : '#dc2626'           // dark red

const now = () => new Date().toLocaleTimeString('en-US', { hour12: false })

export default function DisasterDashboard() {
  const [disasterType, setDisasterType] = useState('Flood')
  const [severity, setSeverity] = useState(5)
  const [notes, setNotes] = useState('')
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showCameras, setShowCameras] = useState(false)
  const [showIntersections, setShowIntersections] = useState(false)
  const [h3LevelIdx, setH3LevelIdx] = useState(2) // ~920m
  const [mapStyle, setMapStyle] = useState('dark')
  const [city, setCity] = useState(DEFAULT_CITY) // { id, name, shortName, polygon, bounds } | null

  // Routing state
  const [waypoints, setWaypoints] = useState({ start: null, end: null })
  const [waypointMode, setWaypointMode] = useState(null) // 'start' | 'end' | null
  const [route, setRoute] = useState(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeError, setRouteError] = useState(null)

  const h3Level = H3_LEVELS[h3LevelIdx]
  const [logOpen, setLogOpen] = useState(true)
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'System ready.' },
  ])

  const addLog = (type, message) =>
    setLog((prev) => [{ type, time: now(), message }, ...prev].slice(0, 80))

  // Draft values (what the next-drawn zone will inherit) — kept in a ref so
  // the zone-add callback has stable identity and doesn't re-bind Geoman.
  const draftRef = useRef({ disasterType, severity, notes })
  useEffect(() => {
    draftRef.current = { disasterType, severity, notes }
  }, [disasterType, severity, notes])

  const handleZoneAdd = useCallback(({ id, geometry }) => {
    const d = draftRef.current
    const t = DISASTER_TYPES.find((x) => x.value === d.disasterType) || DISASTER_TYPES[0]
    const zone = {
      id,
      type: d.disasterType,
      typeLabel: t.label,
      typeIcon: t.icon,
      color: t.color,
      severity: d.severity,
      notes: d.notes.trim() || null,
      geometry,
    }
    setZones((prev) => [...prev, zone])
    setLog((prev) =>
      [{ type: 'info', time: now(), message: `Zone added: ${t.label} (severity ${d.severity}).` }, ...prev].slice(0, 80),
    )
  }, [])

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
  const sev = severityColor(severity)
  const severityPct = ((severity - 1) / 9) * 100

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

          {/* Severity */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <SectionLabel className="mb-0">Severity</SectionLabel>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium tabular-nums" style={{ color: sev }}>
                  {severity}
                </span>
                <span className="text-[11px] text-zinc-500">{severityLabel(severity)}</span>
              </div>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={severity}
              onChange={(e) => setSeverity(Number(e.target.value))}
              style={{ '--range-pct': `${severityPct}%`, '--range-color': sev }}
            />
            <div className="flex justify-between mt-1.5 text-[10px] text-zinc-600 tabular-nums">
              <span>1</span>
              <span>10</span>
            </div>
          </section>

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
            {zones.length === 0 ? (
              <div className="px-3 py-2.5 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 leading-snug">
                Use the drawing tools (top-left) to add zones. Each shape adopts the type, severity, and directives above.
              </div>
            ) : (
              <div className="space-y-1.5">
                {zones.map((z) => (
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
                        Sev {z.severity} · {z.geometry?.type === 'Point' ? 'Circle' : 'Polygon'}
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
                ))}
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
          showGrid={showGrid}
          h3Resolution={h3Level.res}
          mapStyle={mapStyle}
          showCameras={showCameras}
          showIntersections={showIntersections}
          city={city}
          route={route}
          waypoints={waypoints}
          waypointMode={waypointMode}
          onWaypointPick={handleWaypointPick}
        />

        <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2">
          <Segmented value={mapStyle} onChange={setMapStyle} options={MAP_STYLES} />

          <div className="inline-flex items-center gap-2 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-2 py-1">
            <button
              onClick={() => setShowGrid((g) => !g)}
              className={[
                'inline-flex items-center gap-1.5 px-1.5 text-[12px] transition-colors',
                showGrid ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
              ].join(' ')}
            >
              <span
                className={[
                  'w-1.5 h-1.5 rounded-full',
                  showGrid ? 'bg-emerald-500' : 'bg-zinc-600',
                ].join(' ')}
              />
              Grid {showGrid ? 'on' : 'off'}
            </button>

            {showGrid && (
              <>
                <span className="h-3.5 w-px bg-zinc-800" />
                <div className="inline-flex items-center gap-0.5">
                  {H3_LEVELS.map((lvl, i) => {
                    const sel = i === h3LevelIdx
                    return (
                      <button
                        key={lvl.res}
                        onClick={() => setH3LevelIdx(i)}
                        className={[
                          'px-2 py-0.5 text-[11px] rounded tabular-nums transition-colors',
                          sel
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-500 hover:text-zinc-300',
                        ].join(' ')}
                      >
                        {lvl.label}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setShowCameras((c) => !c)}
            disabled={!showGrid}
            title={!showGrid ? 'Cameras require the grid to be on' : undefined}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              !showGrid
                ? 'text-zinc-600 cursor-not-allowed opacity-60'
                : showCameras
                  ? 'text-zinc-100 hover:border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showCameras && showGrid ? 'bg-amber-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Cameras {showCameras ? 'on' : 'off'}
          </button>

          <button
            onClick={() => setShowIntersections((v) => !v)}
            disabled={!showGrid}
            title={!showGrid ? 'Intersections require the grid to be on' : undefined}
            className={[
              'inline-flex items-center gap-1.5 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] transition-colors',
              !showGrid
                ? 'text-zinc-600 cursor-not-allowed opacity-60'
                : showIntersections
                  ? 'text-zinc-100 hover:border-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                showIntersections && showGrid ? 'bg-sky-400' : 'bg-zinc-600',
              ].join(' ')}
            />
            Intersections {showIntersections ? 'on' : 'off'}
          </button>
        </div>
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
