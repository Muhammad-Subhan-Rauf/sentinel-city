// ============================================================
// DisasterDashboard.jsx — Main command-center UI (Floating Glass Edition)
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
    info: 'text-[#c9d6f0]', pending: 'text-[#f97316]',
  }
  return (
    <div className={`flex items-start gap-2 text-xs font-mono py-1.5 border-b border-white/10 ${colors[entry.type]}`}>
      <span className="shrink-0 mt-0.5">{icons[entry.type]}</span>
      <span className="text-[#6b82a8] shrink-0 font-semibold">{entry.time}</span>
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
  const [mapStyle, setMapStyle] = useState('dark') // Default to tactical dark map for incredible contrast
  const [stats, setStats] = useState({ latency: 14, activeAgents: 12 })
  const [log, setLog] = useState([
    { type: 'info', time: now(), message: 'Sentinel-City AI Core initialized. All sub-systems nominal.' },
    { type: 'info', time: now(), message: 'H3 geospatial indexing engine synchronized.' },
  ])

  function now() {
    return new Date().toLocaleTimeString('en-US', { hour12: false })
  }

  function addLog(type, message) {
    setLog(prev => [{ type, time: now(), message }, ...prev].slice(0, 60))
  }

  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        latency: Math.floor(10 + Math.random() * 6),
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
    addLog('pending', `Transmitting ${disasterType} payload to backend orchestration node…`)

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
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#060c1a] relative select-none">
      <div className="scanline" />

      {/* ─── FULLSCREEN BACKGROUND MAP ─────────────────────────────────────────── */}
      <div className="absolute inset-0 z-0">
        <MapView onShapeDrawn={handleShapeDrawn} showGrid={showGrid} mapStyle={mapStyle} />
      </div>

      {/* ─── FLOATING LEFT SIDEBAR (COMMAND CENTER) ─────────────────────────── */}
      <aside
        className="absolute top-5 left-16 z-30 w-[380px] max-h-[calc(100vh-80px)] flex flex-col rounded-2xl overflow-hidden glass-panel-glow transition-all duration-300"
        style={{ '--glow-border': `${activeColor}66`, '--glow-shadow': `${activeColor}22` }}
      >
        {/* Banner */}
        <div className="p-4 border-b border-white/10 bg-[#0b1224]/90 backdrop-blur-md flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-2xl shadow-lg transition-all duration-300"
              style={{ background: activeColor, boxShadow: `0 0 20px ${activeColor}88` }}
            >
              <span>{currentDisaster?.icon}</span>
            </div>
            <div>
              <h1 className="text-white font-extrabold text-base tracking-tight leading-tight flex items-center gap-1.5 font-sans">
                Sentinel<span style={{ color: activeColor }}>-</span>City
              </h1>
              <p className="text-[#6b82a8] text-[10px] font-mono tracking-widest uppercase mt-0.5">Disaster Orchestration</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/30 text-green-400 text-[10px] font-mono tracking-wider font-bold shadow-[0_0_15px_rgba(34,197,94,0.2)]">
            <span className="w-2 h-2 rounded-full bg-green-500 status-blink shadow-[0_0_8px_#22c55e]" />
            ONLINE
          </span>
        </div>

        {/* Scrollable Form Area */}
        <div className="flex-1 p-5 space-y-5 overflow-y-auto">

          {/* Disaster Type Selector Grid */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[#c9d6f0] text-[11px] font-bold font-mono uppercase tracking-widest flex items-center gap-1.5">
                <span className="text-[#00f2fe]">01.</span> DISASTER VECTOR
              </label>
              <span className="text-[11px] font-mono font-bold" style={{ color: activeColor }}>
                {disasterType}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {DISASTER_TYPES.map(d => {
                const isSelected = disasterType === d.value
                return (
                  <button
                    key={d.value}
                    id={`btn-type-${d.value.toLowerCase()}`}
                    onClick={() => setDisasterType(d.value)}
                    className="group relative flex flex-col p-3 rounded-xl border text-left transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      background: isSelected ? `${d.color}22` : 'rgba(15, 23, 42, 0.65)',
                      borderColor: isSelected ? d.color : 'rgba(255, 255, 255, 0.1)',
                      boxShadow: isSelected ? `0 0 20px ${d.color}44, inset 0 0 12px ${d.color}22` : 'none',
                    }}
                  >
                    <div className="flex items-center justify-between w-full mb-1.5">
                      <span className="text-xl">{d.icon}</span>
                      <div
                        className="w-2.5 h-2.5 rounded-full transition-all duration-300"
                        style={{
                          background: isSelected ? d.color : 'rgba(255,255,255,0.2)',
                          boxShadow: isSelected ? `0 0 10px ${d.color}` : 'none',
                        }}
                      />
                    </div>
                    <span className="text-xs font-bold text-white tracking-wide font-sans leading-tight">
                      {d.label}
                    </span>
                    <span className="text-[10px] text-[#6b82a8] line-clamp-1 mt-0.5 font-sans font-light">
                      {d.desc}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Severity & Meter */}
          <div className="p-4 rounded-xl bg-[#0b1224]/80 border border-white/10 shadow-inner">
            <div className="flex items-center justify-between mb-3">
              <label className="text-[#c9d6f0] text-[11px] font-bold font-mono uppercase tracking-widest flex items-center gap-1.5">
                <span className="text-[#00f2fe]">02.</span> IMPACT SEVERITY
              </label>
              <div className="flex items-center gap-2 font-mono">
                <span className="text-base font-extrabold" style={{ color: SEVERITY_COLORS[severity] }}>
                  {severity}
                </span>
                <span
                  className="text-[10px] px-2 py-0.5 rounded font-extrabold uppercase tracking-wider"
                  style={{
                    background: `${SEVERITY_COLORS[severity]}25`,
                    color: SEVERITY_COLORS[severity],
                    border: `1px solid ${SEVERITY_COLORS[severity]}66`,
                  }}
                >
                  {SEVERITY_LABELS[severity]}
                </span>
              </div>
            </div>

            {/* LED Display Bars */}
            <div className="grid grid-cols-10 gap-1 mb-3">
              {Array.from({ length: 10 }).map((_, idx) => {
                const level = idx + 1
                const isActive = level <= severity
                return (
                  <div
                    key={level}
                    className="h-2 rounded-sm transition-all duration-300"
                    style={{
                      background: isActive ? SEVERITY_COLORS[level] : 'rgba(255,255,255,0.1)',
                      boxShadow: isActive ? `0 0 12px ${SEVERITY_COLORS[level]}aa` : 'none',
                      opacity: isActive ? 1 : 0.25,
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

          {/* Operator Directives */}
          <div>
            <label className="text-[#c9d6f0] text-[11px] font-bold font-mono uppercase tracking-widest flex items-center gap-1.5 mb-2">
              <span className="text-[#00f2fe]">03.</span> OPERATOR DIRECTIVES <span className="text-[#6b82a8] normal-case font-normal">(optional)</span>
            </label>
            <textarea
              id="textarea-notes"
              rows={3} value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Specify target facilities, priority evacuation corridors, or AI emergency overrides..."
              className="w-full bg-[#0b1224]/80 border border-white/10 rounded-xl p-3.5
                         text-white placeholder-[#4b6082] text-xs resize-none font-sans
                         focus:outline-none focus:border-[#00f2fe] focus:shadow-[0_0_20px_rgba(0,242,254,0.25)] transition-all"
            />
          </div>

          {/* Target Zone Verification Banner */}
          <div
            className="flex items-center gap-3 p-3.5 rounded-xl border text-xs font-mono transition-all duration-300"
            style={{
              background: geometry ? 'rgba(34,197,94,0.12)' : 'rgba(15,23,42,0.6)',
              borderColor: geometry ? '#22c55e88' : 'rgba(255,255,255,0.1)',
              color: geometry ? '#22c55e' : '#6b82a8',
              boxShadow: geometry ? '0 0 25px rgba(34,197,94,0.2)' : 'none',
            }}
          >
            <span className="text-xl flex items-center justify-center w-7 h-7 rounded-lg bg-black/25 shrink-0">
              {geometry ? '✓' : '⌖'}
            </span>
            <div className="flex flex-col">
              <span className="font-bold text-white text-xs">
                {geometry ? `TARGET LOCKED: ${geometry.type.toUpperCase()}` : 'NO TARGET ZONE SELECTED'}
              </span>
              <span className="text-[10px] opacity-80 mt-0.5">
                {geometry ? 'GeoJSON coordinates extracted successfully' : 'Use map drawing tools to define impact area'}
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
                ? `linear-gradient(135deg, ${activeColor}, ${activeColor}dd)`
                : 'rgba(15,23,42,0.8)',
              color: geometry && !loading ? 'white' : '#6b82a8',
              border: `1px solid ${geometry && !loading ? activeColor : 'rgba(255,255,255,0.1)'}`,
              boxShadow: geometry && !loading ? `0 0 35px ${activeColor}88` : 'none',
            }}
          >
            {geometry && !loading && (
              <div className="absolute inset-0 w-1/2 h-full bg-white/25 skew-x-12 translate-x-[-150%] group-hover:translate-x-[300%] transition-transform duration-1000 pointer-events-none" />
            )}
            {loading ? (
              <span className="flex items-center justify-center gap-2.5">
                <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ORCHESTRATING AI PROTOCOL…
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <span className="text-lg">⚡</span> TRIGGER {disasterType.toUpperCase()}
              </span>
            )}
          </button>
        </div>

        {/* Live Activity Terminal */}
        <div className="border-t border-white/10 bg-[#080d1e]/95 p-4 backdrop-blur-lg">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[#c9d6f0] text-[10px] font-bold font-mono uppercase tracking-widest flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#00f2fe] animate-pulse" />
              SYSTEM ACTIVITY LOG
            </span>
            <button
              onClick={() => setLog([{ type: 'info', time: now(), message: 'Terminal log cleared.' }])}
              className="text-[#6b82a8] text-[10px] font-mono hover:text-[#00f2fe] transition-colors"
            >
              [CLEAR]
            </button>
          </div>
          <div className="max-h-[140px] overflow-y-auto pr-1 space-y-1 rounded-xl bg-black/40 p-3 border border-white/5 shadow-inner">
            {log.map((entry, i) => <LogEntry key={i} entry={entry} />)}
          </div>
        </div>
      </aside>

      {/* ─── FLOATING TOP-RIGHT CONTROLS BAR ────────────────────────────────── */}
      <div className="absolute top-5 right-5 z-30 flex items-center gap-3 select-none">
        
        {/* Map Theme Selector Pill */}
        <div className="flex items-center gap-1 p-1 bg-[#0b1224]/90 backdrop-blur-xl border border-white/10 rounded-xl shadow-[0_15px_35px_rgba(0,0,0,0.5)] font-sans">
          <button
            onClick={() => setMapStyle('dark')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
              mapStyle === 'dark' ? 'bg-[#00f2fe] text-black shadow-[0_0_20px_rgba(0,242,254,0.6)] font-bold' : 'text-[#c9d6f0] hover:text-white'
            }`}
          >
            <span>🌙</span> Tactical
          </button>
          <button
            onClick={() => setMapStyle('colored')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
              mapStyle === 'colored' ? 'bg-[#00f2fe] text-black shadow-[0_0_20px_rgba(0,242,254,0.6)] font-bold' : 'text-[#c9d6f0] hover:text-white'
            }`}
          >
            <span>🌍</span> Voyager
          </button>
          <button
            onClick={() => setMapStyle('satellite')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
              mapStyle === 'satellite' ? 'bg-[#00f2fe] text-black shadow-[0_0_20px_rgba(0,242,254,0.6)] font-bold' : 'text-[#c9d6f0] hover:text-white'
            }`}
          >
            <span>🛰️</span> Satellite
          </button>
        </div>

        {/* H3 Grid Toggle Pill */}
        <button
          onClick={() => setShowGrid(g => !g)}
          className={`flex items-center gap-2 px-4 py-2 bg-[#0b1224]/90 backdrop-blur-xl border rounded-xl text-xs font-mono font-bold transition-all duration-300 shadow-[0_15px_35px_rgba(0,0,0,0.5)] ${
            showGrid ? 'border-[#00f2fe] text-[#00f2fe] shadow-[0_0_25px_rgba(0,242,254,0.35)]' : 'border-white/10 text-[#6b82a8]'
          }`}
        >
          <span className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${showGrid ? 'bg-[#00f2fe] shadow-[0_0_12px_#00f2fe]' : 'bg-[#4b6082]'}`} />
          H3-INDEX: {showGrid ? 'ACTIVE' : 'OFF'}
        </button>

        {/* Active Vector Indicator Pill */}
        <div
          className="flex items-center gap-2.5 px-4 py-2 bg-[#0b1224]/90 backdrop-blur-xl border rounded-xl shadow-[0_15px_35px_rgba(0,0,0,0.5)] transition-all duration-300"
          style={{ borderColor: `${activeColor}66`, boxShadow: `0 0 25px ${activeColor}33` }}
        >
          <span className="w-2.5 h-2.5 rounded-full status-blink shrink-0" style={{ background: activeColor, boxShadow: `0 0 12px ${activeColor}` }} />
          <span className="text-xs font-mono font-extrabold text-white uppercase tracking-wider flex items-center gap-1.5">
            <span>{currentDisaster?.icon}</span> {disasterType} · <span style={{ color: activeColor }}>SEV {severity}</span>
          </span>
        </div>
      </div>

      {/* Floating Drawing Instructions HUD Pill */}
      {!geometry && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-[500] pointer-events-none animate-[fadeIn_0.5s_ease-out] select-none">
          <div className="flex items-center gap-3 px-6 py-3.5 bg-[#0b1224]/95 backdrop-blur-xl border border-[#00f2fe]/50 rounded-full shadow-[0_15px_50px_rgba(0,0,0,0.8),0_0_30px_rgba(0,242,254,0.3)]">
            <span className="flex h-3 w-3 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00f2fe] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00f2fe]"></span>
            </span>
            <span className="text-xs font-mono font-extrabold text-white tracking-wider">
              USE LEFT TOOLBAR TO DRAW AN IMPACT POLYGON / CIRCLE
            </span>
          </div>
        </div>
      )}

      {/* ─── BOTTOM TELEMETRY BAR ────────────────────────────────────────────── */}
      <footer className="absolute bottom-0 inset-x-0 h-8 bg-[#060c1a]/95 backdrop-blur border-t border-white/10 flex items-center justify-between px-6 z-30 font-mono text-[11px] text-[#6b82a8] select-none">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2 font-bold">
            <span className="w-2 h-2 rounded-full bg-[#00f2fe]" />
            NODE: <span className="text-white">SENTINEL-ALPHA-01</span>
          </span>
          <span className="flex items-center gap-2 font-bold">
            <span className="text-[#f97316]">⚡</span> AI ORCHESTRATION: <span className="text-[#f97316]">{stats.activeAgents} AGENTS ACTIVE</span>
          </span>
          <span>
            GEO-HASH: <b className="text-[#00f2fe]">UBER-H3 v4.4</b>
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span>
            LATENCY: <b className="text-green-400">{stats.latency}ms</b>
          </span>
          <span>
            DB PROTOCOL: <b className="text-green-400">POSTGIS SECURE STREAM</b>
          </span>
          <span className="text-[#4b6082]">
            UTC: {new Date().toISOString().slice(0, 19).replace('T', ' ')}
          </span>
        </div>
      </footer>
    </div>
  )
}
