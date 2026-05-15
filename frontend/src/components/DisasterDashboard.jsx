// ============================================================
// DisasterDashboard.jsx — Main command-center UI (Premium HUD Edition)
// ============================================================
import { useState, useCallback, useEffect } from 'react'
import MapView from './MapView'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

const DISASTER_TYPES = [
  { value: 'Earthquake',   label: 'Earthquake',   icon: '🌍', color: '#f59e0b', desc: 'Seismic fault rupture' },
  { value: 'Flood',        label: 'Flood',        icon: '🌊', color: '#3b82f6', desc: 'Rapid water overflow' },
  { value: 'Wildfire',     label: 'Wildfire',     icon: '🔥', color: '#ef4444', desc: 'Uncontrolled forest blaze' },
  { value: 'Hurricane',    label: 'Hurricane',    icon: '🌀', color: '#8b5cf6', desc: 'Category 5 atmospheric storm' },
  { value: 'Tsunami',      label: 'Tsunami',      icon: '🌊', color: '#06b6d4', desc: 'Oceanic displacement wave' },
  { value: 'Landslide',    label: 'Landslide',    icon: '⛰️',  color: '#d97706', desc: 'Slope failure & debris flow' },
  { value: 'Nuclear_Leak', label: 'Nuclear Leak', icon: '☢️',  color: '#22c55e', desc: 'Reactor containment breach' },
  { value: 'Pandemic',     label: 'Pandemic',     icon: '🦠', color: '#ec4899', desc: 'Viral pathogen contagion' },
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
    success: 'text-[#22c55e]', error: 'text-[#ef4444]',
    info: 'text-[#6b82a8]', pending: 'text-[#f97316]',
  }
  return (
    <div className={`flex items-start gap-2 text-xs font-mono py-1.5 border-b border-[#1e2d4d]/60 ${colors[entry.type]} transition-opacity duration-300`}>
      <span className="shrink-0 mt-0.5">{icons[entry.type]}</span>
      <span className="text-[#4b6082] shrink-0 font-semibold">{entry.time}</span>
      <span className="flex-1 break-words">{entry.message}</span>
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
  const [mapStyle, setMapStyle] = useState('colored')
  const [stats, setStats] = useState({ latency: 14, activeAgents: 12 })
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'Sentinel-City AI Core online. All sub-systems nominal.' },
    { type: 'info', time: now(), message: 'H3 geospatial indexing engine synchronized.' },
  ])

  function now() {
    return new Date().toLocaleTimeString('en-US', { hour12: false })
  }

  function addLog(type, message) {
    setLog(prev => [{ type, time: now(), message }, ...prev].slice(0, 60))
  }

  // Periodic simulated stats jitter for real-time feel
  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        latency: Math.floor(12 + Math.random() * 6),
        activeAgents: Math.floor(12 + Math.random() * 3),
      })
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  const handleShapeDrawn = useCallback((geo) => {
    setGeometry(geo)
    addLog('info', `Target zone locked (${geo.type}). Coordinates extracted.`)
  }, [])

  const currentDisaster = DISASTER_TYPES.find(d => d.value === disasterType)

  const handleTrigger = async () => {
    if (!geometry) {
      addLog('error', 'No geospatial zone defined. Please draw a polygon/circle on the map.')
      return
    }

    setLoading(true)
    addLog('pending', `Encoding ${disasterType} payload & transmitting to backend orchestration node…`)

    try {
      const startTime = Date.now()
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

      const elapsed = Date.now() - startTime
      addLog('success', `[EVENT ${result.event_id}] Transmitted in ${elapsed}ms. Status: RECORDED.`)
      addLog('success', `⚡ Sentinel AI Agents activated for ${disasterType} (Severity ${severity}).`)
      setGeometry(null)
    } catch (err) {
      addLog('error', `Handoff failure: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const severityPct = ((severity - 1) / 9) * 100
  const activeColor = currentDisaster?.color || '#f97316'

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-[#0a0e1a]">
      <div className="scanline" />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden relative">
        
        {/* ─── SIDEBAR COMMAND CENTER ─────────────────────────────────────────── */}
        <aside className="w-[360px] shrink-0 flex flex-col bg-[#0f1629] border-r border-[#1e2d4d] z-20 shadow-[20px_0_40px_rgba(0,0,0,0.5)] overflow-y-auto">

          {/* Top Banner */}
          <div className="p-5 border-b border-[#1e2d4d] bg-gradient-to-b from-[#141d35] to-[#0f1629]">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-500 shadow-lg"
                  style={{ background: activeColor, boxShadow: `0 0 20px ${activeColor}88` }}
                >
                  <span className="text-xl">{currentDisaster?.icon}</span>
                </div>
                <div>
                  <h1 className="text-white font-extrabold text-lg tracking-tight flex items-center gap-1.5">
                    Sentinel<span style={{ color: activeColor }}>-</span>City
                  </h1>
                  <p className="text-[#6b82a8] text-[10px] font-mono tracking-widest uppercase">Disaster Orchestration HUD</p>
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#22c55e]/10 border border-[#22c55e]/30 text-[#22c55e] text-[9px] font-mono tracking-wider font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] status-blink" />
                  ONLINE
                </span>
              </div>
            </div>
          </div>

          {/* Form Body */}
          <div className="flex-1 p-5 space-y-6">

            {/* Disaster Type Grid */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <label className="text-[#6b82a8] text-[10px] font-bold font-mono uppercase tracking-widest">
                  1. Select Disaster Vector
                </label>
                <span className="text-[10px] font-mono text-[#c9d6f0]">{disasterType}</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {DISASTER_TYPES.map(d => {
                  const isSelected = disasterType === d.value
                  return (
                    <button
                      key={d.value}
                      id={`btn-type-${d.value.toLowerCase()}`}
                      onClick={() => setDisasterType(d.value)}
                      className="group relative flex flex-col p-3 rounded-xl border text-left transition-all duration-300 hover:-translate-y-0.5 active:translate-y-0"
                      style={{
                        background: isSelected ? `${d.color}15` : '#141d3588',
                        borderColor: isSelected ? d.color : '#1e2d4d',
                        boxShadow: isSelected ? `0 0 20px ${d.color}33, inset 0 0 10px ${d.color}15` : 'none',
                      }}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="text-lg">{d.icon}</span>
                        <div
                          className="w-2 h-2 rounded-full transition-all duration-300"
                          style={{
                            background: isSelected ? d.color : '#4b6082',
                            boxShadow: isSelected ? `0 0 8px ${d.color}` : 'none',
                          }}
                        />
                      </div>
                      <span className="text-xs font-bold text-white group-hover:text-white transition-colors">
                        {d.label}
                      </span>
                      <span className="text-[10px] text-[#6b82a8] line-clamp-1 mt-0.5 font-light">
                        {d.desc}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Severity Slider & Visual Meter */}
            <div className="p-4 rounded-xl bg-[#141d35]/60 border border-[#1e2d4d]">
              <div className="flex items-center justify-between mb-3">
                <label className="text-[#6b82a8] text-[10px] font-bold font-mono uppercase tracking-widest">
                  2. Impact Severity
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-base font-extrabold font-mono" style={{ color: SEVERITY_COLORS[severity] }}>
                    {severity}
                  </span>
                  <span
                    className="text-[10px] font-mono px-2 py-0.5 rounded-md font-bold uppercase tracking-wider"
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

              {/* Segmented LED Bar Display */}
              <div className="grid grid-cols-10 gap-1 mb-3">
                {Array.from({ length: 10 }).map((_, idx) => {
                  const level = idx + 1
                  const isActive = level <= severity
                  return (
                    <div
                      key={level}
                      className="h-2 rounded-sm transition-all duration-300"
                      style={{
                        background: isActive ? SEVERITY_COLORS[level] : '#1e2d4d',
                        boxShadow: isActive ? `0 0 10px ${SEVERITY_COLORS[level]}88` : 'none',
                        opacity: isActive ? 1 : 0.3,
                      }}
                    />
                  )
                })}
              </div>

              <input
                id="slider-severity"
                type="range" min={1} max={10} value={severity}
                onChange={e => setSeverity(Number(e.target.value))}
                className="w-full cursor-pointer mt-1"
                style={{ '--range-pct': `${severityPct}%`, '--slider-color': SEVERITY_COLORS[severity] }}
              />
              <div className="flex justify-between mt-2 text-[10px] font-mono text-[#6b82a8]">
                <span>1 MINOR</span>
                <span>5 MODERATE</span>
                <span>10 CATASTROPHIC</span>
              </div>
            </div>

            {/* Operator Notes */}
            <div>
              <label className="block text-[#6b82a8] text-[10px] font-bold font-mono uppercase tracking-widest mb-2">
                3. Tactical Directives <span className="text-[#4b6082] normal-case font-sans font-normal">(optional notes)</span>
              </label>
              <textarea
                id="textarea-notes"
                rows={3} value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Specify target structures, priority evacuation routes, or AI agent override instructions..."
                className="w-full bg-[#141d35] border border-[#1e2d4d] rounded-xl p-3.5
                           text-[#c9d6f0] placeholder-[#4b6082] text-xs resize-none font-sans
                           focus:outline-none focus:border-[#06b6d4] focus:shadow-[0_0_15px_rgba(6,182,212,0.2)] transition-all"
              />
            </div>

            {/* Geometry / Zone Status */}
            <div
              className="flex items-center gap-3 p-3.5 rounded-xl border text-xs font-mono transition-all duration-300 shadow-sm"
              style={{
                background: geometry ? 'rgba(34,197,94,0.1)' : 'rgba(30,45,77,0.4)',
                borderColor: geometry ? '#22c55e66' : '#1e2d4d',
                color: geometry ? '#22c55e' : '#6b82a8',
                boxShadow: geometry ? '0 0 20px rgba(34,197,94,0.15)' : 'none',
              }}
            >
              <span className="text-xl flex items-center justify-center w-6 h-6 rounded-lg bg-black/20">
                {geometry ? '✓' : '⌖'}
              </span>
              <div className="flex flex-col">
                <span className="font-bold text-white">
                  {geometry ? `ZONE DEFINED: ${geometry.type.toUpperCase()}` : 'NO TARGET ZONE SELECTED'}
                </span>
                <span className="text-[10px] opacity-80">
                  {geometry ? 'GeoJSON coordinates extracted & verified' : 'Use map drawing tools to define boundary'}
                </span>
              </div>
            </div>

            {/* Trigger Button */}
            <button
              id="btn-trigger-disaster"
              onClick={handleTrigger}
              disabled={loading || !geometry}
              className="group relative w-full py-4 rounded-xl font-extrabold text-sm font-mono uppercase tracking-widest transition-all duration-300 shadow-xl overflow-hidden
                         disabled:opacity-40 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: geometry && !loading
                  ? `linear-gradient(135deg, ${activeColor}, ${activeColor}cc)`
                  : '#141d35',
                color: geometry && !loading ? 'white' : '#6b82a8',
                border: `1px solid ${geometry && !loading ? activeColor : '#1e2d4d'}`,
                boxShadow: geometry && !loading ? `0 0 30px ${activeColor}66` : 'none',
              }}
            >
              {/* Highlight shimmer effect */}
              {geometry && !loading && (
                <div className="absolute inset-0 w-1/2 h-full bg-white/20 skew-x-12 translate-x-[-150%] group-hover:translate-x-[300%] transition-transform duration-1000 pointer-events-none" />
              )}
              {loading ? (
                <span className="flex items-center justify-center gap-2.5">
                  <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ORCHESTRATING AI RESPONSE…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <span className="text-lg">⚡</span> EXECUTE {disasterType.toUpperCase()} PROTOCOL
                </span>
              )}
            </button>
          </div>

          {/* Activity Log Terminal */}
          <div className="border-t border-[#1e2d4d] bg-[#0c1222] p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[#6b82a8] text-[10px] font-bold font-mono uppercase tracking-widest flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#f97316]" />
                System Activity Stream
              </span>
              <button
                onClick={() => setLog([{ type: 'info', time: now(), message: 'Activity stream reset.' }])}
                className="text-[#4b6082] text-[10px] font-mono hover:text-[#f97316] transition-colors"
              >
                [CLEAR]
              </button>
            </div>
            <div className="max-h-[180px] overflow-y-auto pr-1 space-y-1 rounded-lg bg-[#060c1a]/80 p-2.5 border border-[#1e2d4d]/40 shadow-inner">
              {log.map((entry, i) => <LogEntry key={i} entry={entry} />)}
            </div>
          </div>
        </aside>

        {/* ─── MAP INTERACTIVE HUD ─────────────────────────────────────────── */}
        <main className="flex-1 relative bg-[#060c1a]">
          
          {/* Top Floating Controls Bar */}
          <div className="absolute top-4 right-4 z-[500] flex items-center gap-3">
            
            {/* Map Theme Selector Glass Pill */}
            <div className="flex items-center gap-1 p-1 bg-[#0f1629]/85 backdrop-blur-md border border-[#1e2d4d] rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
              <button
                onClick={() => setMapStyle('colored')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
                  mapStyle === 'colored' ? 'bg-[#06b6d4] text-white shadow-[0_0_15px_rgba(6,182,212,0.5)] font-bold' : 'text-[#6b82a8] hover:text-white'
                }`}
              >
                <span>🌍</span> Colored
              </button>
              <button
                onClick={() => setMapStyle('dark')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
                  mapStyle === 'dark' ? 'bg-[#06b6d4] text-white shadow-[0_0_15px_rgba(6,182,212,0.5)] font-bold' : 'text-[#6b82a8] hover:text-white'
                }`}
              >
                <span>🌙</span> Tactical
              </button>
              <button
                onClick={() => setMapStyle('satellite')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
                  mapStyle === 'satellite' ? 'bg-[#06b6d4] text-white shadow-[0_0_15px_rgba(6,182,212,0.5)] font-bold' : 'text-[#6b82a8] hover:text-white'
                }`}
              >
                <span>🛰️</span> Orbit
              </button>
            </div>

            {/* H3 Grid Toggle Pill */}
            <button
              onClick={() => setShowGrid(g => !g)}
              className={`flex items-center gap-2 px-4 py-2 bg-[#0f1629]/85 backdrop-blur-md border rounded-xl text-xs font-mono font-bold transition-all duration-300 shadow-[0_10px_30px_rgba(0,0,0,0.5)] ${
                showGrid ? 'border-[#06b6d4] text-[#06b6d4] shadow-[0_0_20px_rgba(6,182,212,0.3)]' : 'border-[#1e2d4d] text-[#6b82a8]'
              }`}
            >
              <span className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${showGrid ? 'bg-[#06b6d4] shadow-[0_0_10px_#06b6d4]' : 'bg-[#4b6082]'}`} />
              H3-GRID: {showGrid ? 'ACTIVE' : 'OFF'}
            </button>

            {/* Active Disaster Status Badge */}
            <div
              className="flex items-center gap-2.5 px-4 py-2 bg-[#0f1629]/85 backdrop-blur-md border rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.5)] transition-all duration-300"
              style={{ borderColor: `${activeColor}66`, boxShadow: `0 0 20px ${activeColor}22` }}
            >
              <span className="w-2.5 h-2.5 rounded-full status-blink" style={{ background: activeColor, boxShadow: `0 0 10px ${activeColor}` }} />
              <span className="text-xs font-mono font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <span>{currentDisaster?.icon}</span> {disasterType} · <span style={{ color: activeColor }}>SEV {severity}</span>
              </span>
            </div>
          </div>

          {/* Floating Instructions HUD */}
          {!geometry && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[500] pointer-events-none animate-[fadeIn_0.5s_ease-out]">
              <div className="flex items-center gap-3 px-6 py-3.5 bg-[#0f1629]/90 backdrop-blur-md border border-[#06b6d4]/40 rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.7),0_0_25px_rgba(6,182,212,0.2)]">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#06b6d4] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-[#06b6d4]"></span>
                </span>
                <span className="text-xs font-mono font-bold text-white tracking-wide">
                  USE LEFT TOOLBAR TO DRAW AN IMPACT POLYGON / CIRCLE
                </span>
              </div>
            </div>
          )}

          <MapView onShapeDrawn={handleShapeDrawn} showGrid={showGrid} mapStyle={mapStyle} />
        </main>
      </div>

      {/* ─── BOTTOM OPERATOR HUD BAR ─────────────────────────────────────────── */}
      <footer className="h-8 shrink-0 bg-[#060c1a] border-t border-[#1e2d4d] flex items-center justify-between px-6 z-30 font-mono text-[11px] text-[#6b82a8]">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#06b6d4]" />
            NODE: <b className="text-white">SENTINEL-ALPHA-01</b>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[#f97316]">⚡</span> AI ORCHESTRATION AGENTS: <b className="text-[#f97316]">{stats.activeAgents} ACTIVE</b>
          </span>
          <span>
            GEO-HASH PROTOCOL: <b className="text-[#06b6d4]">UBER-H3 v4.4</b>
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span>
            LATENCY: <b className="text-green-400">{stats.latency}ms</b>
          </span>
          <span>
            DB STREAM: <b className="text-green-400">POSTGIS SECURE</b>
          </span>
          <span className="text-[#4b6082]">
            UTC: {new Date().toISOString().slice(0, 19).replace('T', ' ')}
          </span>
        </div>
      </footer>
    </div>
  )
}
