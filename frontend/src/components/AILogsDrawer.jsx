import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'

const EVENT_COLORS = {
  DECISION: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  TOOL_CALL: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  OBSERVATION: 'text-green-400 bg-green-500/10 border-green-500/30',
  RECOVERY_ACTION: 'text-red-400 bg-red-500/10 border-red-500/30',
}

// Sum every counter whose key starts with one of the prefixes
function sumWithPrefix(counters, ...prefixes) {
  if (!counters) return 0
  let total = 0
  for (const [k, v] of Object.entries(counters)) {
    if (prefixes.some(p => k === p || k.startsWith(p + '.'))) total += v
  }
  return total
}

function formatNumber(n) {
  if (n == null) return '0'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export default function AILogsDrawer({
  open,
  onClose,
  backendUrl
}) {
  const [logs, setLogs] = useState([])
  const [metrics, setMetrics] = useState(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!open) return

    let active = true
    const fetchAll = async () => {
      try {
        const [logsRes, metricsRes] = await Promise.all([
          fetch(`${backendUrl}/api/logs?limit=50`),
          fetch(`${backendUrl}/api/metrics`).catch(() => null),
        ])
        if (logsRes && logsRes.ok) {
          const data = await logsRes.json()
          if (active) setLogs(data.logs || [])
        }
        if (metricsRes && metricsRes.ok) {
          const m = await metricsRes.json()
          if (active) setMetrics(m)
        }
      } catch (err) {
        console.error("Failed to fetch logs/metrics", err)
      }
    }

    fetchAll()
    const intervalId = setInterval(fetchAll, 3000)

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [open, backendUrl])

  const handleClearLogs = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/logs`, { method: 'DELETE' })
      if (res.ok) setLogs([])
    } catch (err) {
      console.error("Failed to clear logs", err)
    }
  }

  const [copyState, setCopyState] = useState('idle')  // 'idle' | 'copied' | 'failed'
  const handleCopyLogs = async () => {
    // Serialize the same filtered slice the user is looking at, plus the
    // current metrics snapshot so a paste into Slack / a bug report is
    // self-contained. Newest first matches the on-screen order.
    const filtered = logs.filter(l => filter === 'all' || l.event_type === filter)
    const payload = {
      copied_at: new Date().toISOString(),
      filter,
      metric_counters: metrics?.counters || {},
      logs: filtered,
    }
    const text = JSON.stringify(payload, null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Older browsers / non-secure contexts fall back to a hidden textarea.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1500)
    } catch (err) {
      console.error("Failed to copy logs", err)
      setCopyState('failed')
      setTimeout(() => setCopyState('idle'), 1500)
    }
  }

  const stats = useMemo(() => {
    const c = metrics?.counters || {}
    // Pipeline metrics (single-pass NLU architecture).
    const llmCalls = c['extract.calls_total'] || 0
    const reportsProcessed = c['pipeline.report_processed'] || 0
    const cacheHits = c['pipeline.nlu_cache_hit'] || 0
    const cacheMisses = c['pipeline.nlu_cache_miss'] || 0
    const totalNlu = cacheHits + cacheMisses
    const cacheHitPct = totalNlu > 0 ? Math.round((cacheHits / totalNlu) * 100) : 0

    const incidentsDeclared = c['pipeline.incident_declared'] || 0
    const dispatchesExecuted = c['pipeline.dispatch_executed'] || 0
    const cordonsCreated = c['pipeline.cordon_created'] || 0
    const alertsPublished = c['pipeline.alert_published'] || 0

    const extractErrors = sumWithPrefix(c, 'extract.error')
    const extractTimeouts = c['extract.timeout'] || 0

    return {
      llmCalls, reportsProcessed, cacheHits, cacheHitPct,
      incidentsDeclared, dispatchesExecuted, cordonsCreated, alertsPublished,
      extractErrors, extractTimeouts,
    }
  }, [metrics])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const filteredLogs = logs.filter(l => filter === 'all' || l.event_type === filter)

  const drawer = (
    <>
      <div
        className="fixed inset-0 z-[999] bg-black/30"
        onClick={onClose}
      />
      <div
        className="fixed top-0 bottom-0 left-[360px] w-[450px] z-[1000] flex flex-col bg-zinc-950/95 backdrop-blur border-r border-zinc-800 shadow-[10px_0_30px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold text-zinc-100">AI Logs & Reasoning</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="bg-zinc-800 text-zinc-200 text-[11px] rounded px-2 py-1 border border-zinc-700 outline-none"
            >
              <option value="all">All Events</option>
              <option value="DECISION">Decisions</option>
              <option value="TOOL_CALL">Tool Calls</option>
              <option value="OBSERVATION">Observations</option>
              <option value="RECOVERY_ACTION">Recovery Actions</option>
            </select>
            <button
              type="button"
              onClick={handleCopyLogs}
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] rounded px-2 py-1 border border-zinc-700 transition-colors"
              title="Copy the visible logs + current metrics as JSON to your clipboard"
            >
              {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Failed' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleClearLogs}
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] rounded px-2 py-1 border border-zinc-700 transition-colors"
              title="Clear the in-memory log buffer (JSONL files on disk are kept)"
            >
              Clear
            </button>
            <span className="w-px h-4 bg-zinc-800 mx-1" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AI Logs"
              className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 w-7 h-7 flex items-center justify-center rounded text-[18px] leading-none transition-colors"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        {metrics && (
          <div className="px-5 py-3 border-b border-zinc-800 shrink-0 bg-zinc-900/40">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Live Metrics</div>
            <div className="grid grid-cols-3 gap-2">
              <MetricTile label="LLM calls" value={formatNumber(stats.llmCalls)} accent="zinc" hint="NLU extract" />
              <MetricTile label="Reports" value={formatNumber(stats.reportsProcessed)} accent="zinc" hint="processed" />
              <MetricTile label="NLU cache" value={`${stats.cacheHitPct}%`} accent="emerald" hint={`${formatNumber(stats.cacheHits)} hits`} />
              <MetricTile label="Incidents" value={formatNumber(stats.incidentsDeclared)} accent="blue" hint="declared" />
              <MetricTile label="Dispatches" value={formatNumber(stats.dispatchesExecuted)} accent="blue" />
              <MetricTile label="Cordons" value={formatNumber(stats.cordonsCreated)} accent="blue" />
              <MetricTile label="Alerts" value={formatNumber(stats.alertsPublished)} accent="blue" />
              <MetricTile label="Timeouts" value={formatNumber(stats.extractTimeouts)} accent={stats.extractTimeouts > 0 ? "amber" : "zinc"} hint="LLM" />
              <MetricTile label="Errors" value={formatNumber(stats.extractErrors)} accent={stats.extractErrors > 0 ? "red" : "zinc"} hint="extract" />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3 custom-scrollbar">
          {logs.length === 0 ? (
            <div className="text-center text-[12px] text-zinc-600 py-6">
              Waiting for AI orchestrator to log events...
            </div>
          ) : (
            <div className="space-y-4">
              {filteredLogs.map((log, i) => (
                <div key={i} className="border-l-2 pl-3 pb-2 border-zinc-800">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[10px] text-zinc-500 shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={[
                      'text-[9px] tracking-wider font-semibold px-1.5 py-0.5 rounded border shrink-0',
                      EVENT_COLORS[log.event_type] || 'text-zinc-400 bg-zinc-800 border-zinc-700'
                    ].join(' ')}>
                      {log.event_type}
                    </span>
                  </div>

                  {log.event_type === 'DECISION' && (
                    <div className="text-[12px] text-zinc-200 bg-zinc-900/50 p-2 rounded">
                      <strong className="block text-blue-300 mb-1">{log.details.decision}</strong>
                      <div className="text-zinc-400 leading-snug whitespace-pre-wrap">{log.details.rationale}</div>
                    </div>
                  )}

                  {log.event_type === 'TOOL_CALL' && (
                    <div className="text-[12px] text-zinc-300 bg-zinc-900/50 p-2 rounded">
                      <div><span className="text-purple-300">Tool:</span> {log.details.tool_name}</div>
                      <details className="mt-1">
                        <summary className="text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-300">View Arguments</summary>
                        <pre className="text-[10px] text-zinc-400 mt-1 overflow-x-auto p-1 bg-zinc-950 rounded border border-zinc-800">
                          {JSON.stringify(log.details.arguments, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}

                  {log.event_type === 'OBSERVATION' && (
                    <div className="text-[12px] text-zinc-300 bg-zinc-900/50 p-2 rounded">
                      <div><span className="text-green-300">Source:</span> {log.details.source}</div>
                      <div className="text-zinc-400 text-[11px] truncate mt-1">{typeof log.details.data === 'string' ? log.details.data.substring(0, 100) + '...' : 'Structured data'}</div>
                    </div>
                  )}

                  {log.event_type === 'RECOVERY_ACTION' && (
                    <div className="text-[12px] text-zinc-300 bg-zinc-900/50 p-2 rounded">
                      <div><span className="text-red-300">Problem:</span> <span className="text-zinc-300">{log.details.error_context}</span></div>
                      <div className="text-zinc-400 mt-1"><span className="text-red-300">Action:</span> {log.details.action_taken}</div>
                      {log.details.agent_id && (
                        <div className="text-[10px] text-zinc-500 mt-1">agent: {log.details.agent_id}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )

  return createPortal(drawer, document.body)
}

const ACCENT_CLASSES = {
  zinc:    'border-zinc-700 text-zinc-100',
  emerald: 'border-emerald-700/60 text-emerald-200',
  amber:   'border-amber-700/60 text-amber-200',
  blue:    'border-blue-700/60 text-blue-200',
  red:     'border-red-700/60 text-red-200',
}

function MetricTile({ label, value, accent = 'zinc', hint }) {
  const accentCls = ACCENT_CLASSES[accent] || ACCENT_CLASSES.zinc
  return (
    <div className={`bg-zinc-950/60 rounded border ${accentCls} px-2 py-1.5`}>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 leading-tight">{label}</div>
      <div className="text-[14px] font-semibold leading-tight">{value}</div>
      {hint && <div className="text-[9px] text-zinc-500 leading-tight">{hint}</div>}
    </div>
  )
}
