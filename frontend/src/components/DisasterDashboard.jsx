// ============================================================
// DisasterDashboard.jsx — Main command-center UI (no-auth mode)
// ============================================================
import { useState, useCallback } from 'react'
import MapView from './MapView'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

const DISASTER_TYPES = [
  { value: 'Earthquake',   label: '🌍 Earthquake',   color: '#f59e0b' },
  { value: 'Flood',        label: '🌊 Flood',         color: '#3b82f6' },
  { value: 'Wildfire',     label: '🔥 Wildfire',      color: '#ef4444' },
  { value: 'Hurricane',    label: '🌀 Hurricane',     color: '#8b5cf6' },
  { value: 'Tsunami',      label: '🌊 Tsunami',       color: '#06b6d4' },
  { value: 'Landslide',    label: '⛰️  Landslide',    color: '#a16207' },
  { value: 'Nuclear_Leak', label: '☢️  Nuclear Leak', color: '#22c55e' },
  { value: 'Pandemic',     label: '🦠 Pandemic',      color: '#ec4899' },
]

const SEVERITY_LABELS = {
  1: 'Minimal', 2: 'Very Low', 3: 'Low', 4: 'Moderate',
  5: 'Significant', 6: 'High', 7: 'Very High',
  8: 'Severe', 9: 'Critical', 10: 'CATASTROPHIC',
}

const SEVERITY_COLORS = [
  '', '#22c55e', '#4ade80', '#84cc16', '#a3e635',
  '#facc15', '#fb923c', '#f97316', '#ef4444', '#dc2626', '#991b1b',
]

function LogEntry({ entry }) {
  const icons = { success: '✓', error: '✗', info: '◆', pending: '◌' }
  const colors = {
    success: 'text-green-400', error: 'text-red-400',
    info: 'text-[#6b82a8]', pending: 'text-[#f97316]',
  }
  return (
    <div className={`flex gap-2 text-xs font-mono py-1 border-b border-[#1e2d4d]/50 ${colors[entry.type]}`}>
      <span className="shrink-0">{icons[entry.type]}</span>
      <span className="text-[#4b6082] shrink-0">{entry.time}</span>
      <span>{entry.message}</span>
    </div>
  )
}

export default function DisasterDashboard() {
  const [disasterType, setDisasterType] = useState('Earthquake')
  const [severity, setSeverity] = useState(5)
  const [notes, setNotes] = useState('')
  const [geometry, setGeometry] = useState(null)
  const [loading, setLoading] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [mapStyle, setMapStyle] = useState('colored') // 'colored' | 'dark' | 'satellite'
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'Sentinel-City online. Draw an area to begin.' },
  ])

  function now() {
    return new Date().toLocaleTimeString('en-US', { hour12: false })
  }

  function addLog(type, message) {
    setLog(prev => [{ type, time: now(), message }, ...prev].slice(0, 50))
  }

  const handleShapeDrawn = useCallback((geo) => {
    setGeometry(geo)
    addLog('info', `Area defined: ${geo.type}`)
  }, [])

  const currentDisaster = DISASTER_TYPES.find(d => d.value === disasterType)

  const handleTrigger = async () => {
    if (!geometry) {
      addLog('error', 'No area selected. Draw a shape on the map first.')
      return
    }

    setLoading(true)
    addLog('pending', 'Sending payload to backend…')

    try {
      const response = await fetch(`${BACKEND_URL}/api/trigger-disaster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disaster_type: disasterType,
          severity,
          geometry,
          notes: notes.trim() || null,
        }),
      })

      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`)

      addLog('success', `Event ID ${result.event_id} — ${disasterType} (Severity ${severity}) ACTIVE`)
      addLog('success', 'Sentinel agents dispatched.')
      setGeometry(null)
    } catch (err) {
      addLog('error', err.message)
    } finally {
      setLoading(false)
    }
  }

  const severityPct = ((severity - 1) / 9) * 100

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#0a0e1a]">
      <div className="scanline" />

      {/* ─── SIDEBAR ─────────────────────────────────────────── */}
      <aside className="w-80 shrink-0 flex flex-col bg-[#0f1629] border-r border-[#1e2d4d] z-10 overflow-y-auto">

        {/* Header */}
        <div className="px-5 py-4 border-b border-[#1e2d4d]">
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="w-7 h-7 rounded flex items-center justify-center shrink-0"
              style={{ background: currentDisaster?.color || '#f97316', boxShadow: `0 0 14px ${currentDisaster?.color || '#f97316'}55` }}
            >
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <div>
              <h1 className="text-white font-bold text-base leading-tight">
                Sentinel<span style={{ color: currentDisaster?.color || '#f97316' }}>-</span>City
              </h1>
              <p className="text-[#4b6082] text-[10px] tracking-widest uppercase">Command Center</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] status-blink" />
            <span className="text-[#22c55e] text-[10px] font-mono tracking-wider">SYSTEMS NOMINAL</span>
          </div>
        </div>

        {/* Form */}
        <div className="flex-1 px-5 py-5 space-y-5">

          {/* Disaster Type */}
          <div>
            <label className="block text-[#6b82a8] text-[10px] font-semibold uppercase tracking-widest mb-2">
              Disaster Type
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {DISASTER_TYPES.map(d => (
                <button
                  key={d.value}
                  id={`btn-type-${d.value.toLowerCase()}`}
                  onClick={() => setDisasterType(d.value)}
                  className="px-2 py-1.5 rounded-lg text-left text-xs font-medium transition-all border"
                  style={{
                    background: disasterType === d.value ? `${d.color}22` : '#141d35',
                    borderColor: disasterType === d.value ? d.color : '#1e2d4d',
                    color: disasterType === d.value ? d.color : '#6b82a8',
                    boxShadow: disasterType === d.value ? `0 0 10px ${d.color}33` : 'none',
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* Severity */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[#6b82a8] text-[10px] font-semibold uppercase tracking-widest">
                Severity
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold font-mono" style={{ color: SEVERITY_COLORS[severity] }}>
                  {severity}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background: `${SEVERITY_COLORS[severity]}22`,
                    color: SEVERITY_COLORS[severity],
                    border: `1px solid ${SEVERITY_COLORS[severity]}55`,
                  }}
                >
                  {SEVERITY_LABELS[severity]}
                </span>
              </div>
            </div>
            <input
              id="slider-severity"
              type="range" min={1} max={10} value={severity}
              onChange={e => setSeverity(Number(e.target.value))}
              className="w-full h-1 rounded cursor-pointer"
              style={{ '--range-pct': `${severityPct}%`, accentColor: SEVERITY_COLORS[severity] }}
            />
            <div className="flex justify-between mt-1">
              <span className="text-[#4b6082] text-[9px]">1 — Minor</span>
              <span className="text-[#4b6082] text-[9px]">10 — Catastrophic</span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[#6b82a8] text-[10px] font-semibold uppercase tracking-widest mb-2">
              Operator Notes <span className="text-[#4b6082] normal-case">(optional)</span>
            </label>
            <textarea
              id="textarea-notes"
              rows={3} value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Intel, special instructions, affected zones…"
              className="w-full bg-[#141d35] border border-[#1e2d4d] rounded-lg px-3 py-2
                         text-[#c9d6f0] placeholder-[#4b6082] text-xs resize-none
                         focus:outline-none focus:border-[#f97316] transition-all"
            />
          </div>

          {/* Area status */}
          <div
            className="flex items-center gap-2 p-3 rounded-lg border text-xs transition-all"
            style={{
              background: geometry ? 'rgba(34,197,94,0.08)' : 'rgba(30,45,77,0.4)',
              borderColor: geometry ? '#22c55e55' : '#1e2d4d',
              color: geometry ? '#22c55e' : '#4b6082',
            }}
          >
            <span className="text-base">{geometry ? '✓' : '◌'}</span>
            <span>
              {geometry ? `Area selected (${geometry.type})` : 'Draw a zone on the map to continue'}
            </span>
          </div>

          {/* Trigger */}
          <button
            id="btn-trigger-disaster"
            onClick={handleTrigger}
            disabled={loading || !geometry}
            className="w-full py-3 rounded-xl font-bold text-sm uppercase tracking-widest transition-all
                       disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
            style={{
              background: geometry && !loading
                ? `linear-gradient(135deg, ${currentDisaster?.color || '#f97316'}, ${currentDisaster?.color || '#f97316'}cc)`
                : '#141d35',
              color: geometry && !loading ? 'white' : '#4b6082',
              border: `1px solid ${geometry && !loading ? (currentDisaster?.color || '#f97316') : '#1e2d4d'}`,
              boxShadow: geometry && !loading ? `0 0 24px ${currentDisaster?.color || '#f97316'}55` : 'none',
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Dispatching…
              </span>
            ) : `⚡ Trigger ${disasterType}`}
          </button>
        </div>

        {/* Activity Log */}
        <div className="border-t border-[#1e2d4d] px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#6b82a8] text-[10px] font-semibold uppercase tracking-widest">Activity Log</span>
            <button
              onClick={() => setLog([{ type: 'info', time: now(), message: 'Log cleared.' }])}
              className="text-[#4b6082] text-[9px] hover:text-[#f97316] transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {log.map((entry, i) => <LogEntry key={i} entry={entry} />)}
          </div>
        </div>
      </aside>

      {/* ─── MAP ─────────────────────────────────────────────── */}
      <main className="flex-1 relative">
        {/* Top-right Controls Bar: Grid Toggle & Map Theme Toggle */}
        <div className="absolute top-3 right-3 z-[500] flex items-center gap-3.5">
          
          {/* Map style selector */}
          <div className="flex items-center gap-1 p-1 bg-[#0f1629]/90 backdrop-blur border border-[#1e2d4d] rounded-lg">
            <button
              onClick={() => setMapStyle('colored')}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                mapStyle === 'colored' ? 'bg-[#f97316] text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'text-[#6b82a8] hover:text-[#c9d6f0]'
              }`}
            >
              🌍 Colored
            </button>
            <button
              onClick={() => setMapStyle('dark')}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                mapStyle === 'dark' ? 'bg-[#f97316] text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'text-[#6b82a8] hover:text-[#c9d6f0]'
              }`}
            >
              🌙 Dark
            </button>
            <button
              onClick={() => setMapStyle('satellite')}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                mapStyle === 'satellite' ? 'bg-[#f97316] text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'text-[#6b82a8] hover:text-[#c9d6f0]'
              }`}
            >
              🛰️ Sat
            </button>
          </div>

          {/* Grid toggle */}
          <button
            onClick={() => setShowGrid(g => !g)}
            className={`flex items-center gap-2 px-3 py-1.5 bg-[#0f1629]/90 backdrop-blur border rounded-lg text-xs font-mono transition-all ${
              showGrid ? 'border-[#06b6d4] text-[#06b6d4] shadow-[0_0_15px_rgba(6,182,212,0.3)]' : 'border-[#1e2d4d] text-[#6b82a8]'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${showGrid ? 'bg-[#06b6d4] shadow-[0_0_8px_#06b6d4]' : 'bg-[#4b6082]'}`} />
            ⬡ H3 Grid {showGrid ? 'ON' : 'OFF'}
          </button>

          {/* Current Disaster indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0f1629]/90 backdrop-blur border border-[#1e2d4d] rounded-lg">
            <span className="w-1.5 h-1.5 rounded-full status-blink" style={{ background: currentDisaster?.color || '#f97316' }} />
            <span className="text-[10px] font-mono text-[#c9d6f0] uppercase tracking-wider">
              {disasterType} · SEV {severity}
            </span>
          </div>
        </div>

        {!geometry && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[500]
                          px-4 py-2 bg-[#0f1629]/90 backdrop-blur border border-[#1e2d4d]
                          rounded-full text-xs text-[#6b82a8] pointer-events-none shadow-lg">
            ← Use the toolbar on the left to draw a disaster zone
          </div>
        )}

        <MapView onShapeDrawn={handleShapeDrawn} showGrid={showGrid} mapStyle={mapStyle} />
      </main>
    </div>
  )
}
