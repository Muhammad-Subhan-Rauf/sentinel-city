import { useState, useCallback } from 'react'
import MapView from './MapView'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

const DISASTER_TYPES = [
  { value: 'Flood',                  label: 'Flood',                  icon: '🌊' },
  { value: 'Wildfire',               label: 'Wildfire',               icon: '🔥' },
  { value: 'Infrastructure_Failure', label: 'Infrastructure Failure', icon: '🏗️' },
  { value: 'Robbery',                label: 'Robbery',                icon: '💰' },
  { value: 'Gang_Violence',          label: 'Gang Violence',          icon: '⚔️' },
  { value: 'Road_Blockage',          label: 'Road Blockage',          icon: '🚧' },
  { value: 'Accident',               label: 'Accident',               icon: '💥' },
  { value: 'Heatwave',               label: 'Heatwave',               icon: '☀️' },
  { value: 'Power_Outage',           label: 'Power Outage',           icon: '⚡' },
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
  const [geometry, setGeometry] = useState(null)
  const [loading, setLoading] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [h3LevelIdx, setH3LevelIdx] = useState(2) // ~920m
  const [mapStyle, setMapStyle] = useState('dark')

  const h3Level = H3_LEVELS[h3LevelIdx]
  const [logOpen, setLogOpen] = useState(true)
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'System ready.' },
  ])

  const addLog = (type, message) =>
    setLog((prev) => [{ type, time: now(), message }, ...prev].slice(0, 80))

  const handleShapeDrawn = useCallback((geo) => {
    setGeometry(geo)
    addLog('info', `Target zone defined (${geo.type}).`)
  }, [])

  const currentDisaster = DISASTER_TYPES.find((d) => d.value === disasterType) || DISASTER_TYPES[0]
  const sev = severityColor(severity)
  const severityPct = ((severity - 1) / 9) * 100

  const handleTrigger = async () => {
    if (!geometry) {
      addLog('error', 'Define a target zone on the map first.')
      return
    }
    setLoading(true)
    addLog('pending', `Submitting ${currentDisaster.label}…`)

    try {
      const start = Date.now()
      const res = await fetch(`${BACKEND_URL}/api/trigger-disaster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disaster_type: disasterType,
          severity,
          geometry,
          notes: notes.trim() || null,
        }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`)
      const elapsed = Date.now() - start
      const shortId = String(result.event_id || '').slice(0, 8)
      addLog('success', `Event ${shortId} recorded · ${elapsed}ms`)
      setGeometry(null)
    } catch (err) {
      addLog('error', err.message)
    } finally {
      setLoading(false)
    }
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
          {/* Disaster type */}
          <section>
            <SectionLabel>Emergency classification</SectionLabel>
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
                    <span className="truncate">{d.label}</span>
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

          {/* Target zone */}
          <section>
            <SectionLabel>Target zone</SectionLabel>
            <div
              className={[
                'flex items-start gap-3 px-3 py-2.5 rounded-md border text-[12px]',
                geometry
                  ? 'border-emerald-900/60 bg-emerald-950/30'
                  : 'border-zinc-800 bg-zinc-900',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-0.5 text-sm leading-none',
                  geometry ? 'text-emerald-400' : 'text-zinc-600',
                ].join(' ')}
              >
                {geometry ? '✓' : '○'}
              </span>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-zinc-200">
                  {geometry ? `${geometry.type} captured` : 'No zone selected'}
                </span>
                <span className="text-[11px] text-zinc-500 leading-snug">
                  {geometry
                    ? 'GeoJSON ready to submit.'
                    : 'Use the drawing tools on the map (top-left) to define a polygon or circle.'}
                </span>
              </div>
            </div>
          </section>

          {/* Trigger */}
          <button
            id="btn-trigger-disaster"
            onClick={handleTrigger}
            disabled={loading || !geometry}
            className="w-full py-2.5 rounded-md font-medium text-[13px] text-white bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Submitting…
              </span>
            ) : (
              `Trigger ${currentDisaster.label}`
            )}
          </button>
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
          onShapeDrawn={handleShapeDrawn}
          showGrid={showGrid}
          h3Resolution={h3Level.res}
          mapStyle={mapStyle}
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
