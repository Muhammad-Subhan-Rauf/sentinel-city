import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

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

// Format a Date into the value <input type="datetime-local"> expects:
// `YYYY-MM-DDTHH:MM` in local time (no timezone suffix).
function formatDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export default function AILogsDrawer({
  open,
  onClose,
  backendUrl
}) {
  const [logs, setLogs] = useState([])
  const [metrics, setMetrics] = useState(null)
  const [filter, setFilter] = useState('all')
  // Date range — `datetime-local` strings (e.g. "2026-05-31T14:30"). Empty
  // string means unbounded on that side.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Inspector pattern: clicking a table row expands a detail panel beneath it.
  // Stores the timestamp+i composite key of the expanded row, or null.
  const [expandedKey, setExpandedKey] = useState(null)
  // Free-text filter across log text fields. Cheap substring match.
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    if (!open) return

    let active = true
    const fetchAll = async () => {
      try {
        const [logsRes, metricsRes] = await Promise.all([
          // Fetch up to backend max (500) so the date range filter has the
          // full ring buffer to work against, not just the 50 most recent.
          fetch(`${backendUrl}/api/logs?limit=500`),
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

  // `datetime-local` returns a string like "2026-05-31T14:30". Parse to ms.
  // Without a timezone in the string, Date() treats it as local time, which
  // is what the user typed and what log timestamps render as.
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null
  const toMs = dateTo ? new Date(dateTo).getTime() : null
  const dateActive = fromMs != null || toMs != null

  const searchLower = searchText.trim().toLowerCase()
  const filteredLogs = logs.filter((l) => {
    if (filter !== 'all' && l.event_type !== filter) return false
    if (dateActive) {
      const t = new Date(l.timestamp).getTime()
      if (Number.isNaN(t)) return false
      if (fromMs != null && t < fromMs) return false
      if (toMs != null && t > toMs) return false
    }
    if (searchLower) {
      // Search across event_type + a JSON-stringified details blob. Cheap and
      // covers everything: tool name, decision text, observation source, etc.
      const hay = `${l.event_type} ${JSON.stringify(l.details ?? '')}`.toLowerCase()
      if (!hay.includes(searchLower)) return false
    }
    return true
  })

  const clearDateRange = () => {
    setDateFrom('')
    setDateTo('')
  }
  const setQuickRange = (minutesAgo) => {
    const now = new Date()
    const start = new Date(now.getTime() - minutesAgo * 60_000)
    setDateFrom(formatDatetimeLocal(start))
    setDateTo(formatDatetimeLocal(now))
  }

  const drawer = (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[999] bg-black/40 backdrop-blur-xs"
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-label="AI Logs and Reasoning"
            initial={{ y: 12, opacity: 0, scale: 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 12, opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="fixed top-4 bottom-4 left-1/2 -translate-x-1/2 z-[1000] flex flex-col glass-strong rounded-2xl border border-white/[0.08] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] w-[min(calc(77vw-2rem),1080px)]"
            style={{ willChange: 'transform' }}
            onClick={(e) => e.stopPropagation()}
          >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05] shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold text-sentinel-text">AI Logs & Reasoning</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="bg-white/[0.06] text-sentinel-text text-[11px] rounded px-2 py-1 border border-white/[0.08] outline-none"
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
              className="bg-white/[0.06] hover:bg-white/[0.1] text-sentinel-text text-[11px] rounded px-2 py-1 border border-white/[0.08] transition-colors"
              title="Copy the visible logs + current metrics as JSON to your clipboard"
            >
              {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Failed' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleClearLogs}
              className="bg-white/[0.06] hover:bg-white/[0.1] text-sentinel-text text-[11px] rounded px-2 py-1 border border-white/[0.08] transition-colors"
              title="Clear the in-memory log buffer (JSONL files on disk are kept)"
            >
              Clear
            </button>
            <span className="w-px h-4 bg-white/[0.06] mx-1" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AI Logs"
              className="text-sentinel-textDim hover:text-sentinel-text hover:bg-white/[0.06] w-7 h-7 flex items-center justify-center rounded text-[18px] leading-none transition-colors"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        {/* ─── Date / time range filter ─────────────────────── */}
        <div className="px-5 py-3 border-b border-white/[0.05] shrink-0 bg-white/[0.015]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-wider text-sentinel-info/80 font-semibold">
              Time range
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setQuickRange(5)}
                className="text-[10px] px-1.5 py-0.5 rounded text-sentinel-textDim hover:text-sentinel-info hover:bg-white/[0.05] transition-colors"
                title="Last 5 minutes"
              >
                5m
              </button>
              <button
                type="button"
                onClick={() => setQuickRange(15)}
                className="text-[10px] px-1.5 py-0.5 rounded text-sentinel-textDim hover:text-sentinel-info hover:bg-white/[0.05] transition-colors"
                title="Last 15 minutes"
              >
                15m
              </button>
              <button
                type="button"
                onClick={() => setQuickRange(60)}
                className="text-[10px] px-1.5 py-0.5 rounded text-sentinel-textDim hover:text-sentinel-info hover:bg-white/[0.05] transition-colors"
                title="Last hour"
              >
                1h
              </button>
              <button
                type="button"
                onClick={() => setQuickRange(60 * 24)}
                className="text-[10px] px-1.5 py-0.5 rounded text-sentinel-textDim hover:text-sentinel-info hover:bg-white/[0.05] transition-colors"
                title="Last 24 hours"
              >
                24h
              </button>
              {dateActive && (
                <button
                  type="button"
                  onClick={clearDateRange}
                  className="text-[10px] px-1.5 py-0.5 rounded text-sentinel-warn hover:bg-white/[0.05] transition-colors"
                  title="Clear date range"
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="ai-logs-date-from"
                className="block text-[9px] uppercase tracking-wider text-sentinel-textMuted mb-1"
              >
                From
              </label>
              <input
                id="ai-logs-date-from"
                type="datetime-local"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                max={dateTo || undefined}
                className="w-full bg-white/[0.04] text-sentinel-text text-[11px] rounded px-2 py-1 border border-white/[0.08] focus:border-sentinel-info/50 outline-none tabular"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label
                htmlFor="ai-logs-date-to"
                className="block text-[9px] uppercase tracking-wider text-sentinel-textMuted mb-1"
              >
                To
              </label>
              <input
                id="ai-logs-date-to"
                type="datetime-local"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                min={dateFrom || undefined}
                className="w-full bg-white/[0.04] text-sentinel-text text-[11px] rounded px-2 py-1 border border-white/[0.08] focus:border-sentinel-info/50 outline-none tabular"
              />
            </div>
          </div>
          <div className="mt-2 text-[10px] text-sentinel-textMuted tabular">
            {dateActive || filter !== 'all' ? (
              <>
                <span className="text-sentinel-info font-medium">{filteredLogs.length}</span>
                <span> of </span>
                <span className="text-sentinel-textDim">{logs.length}</span>
                <span> matching</span>
              </>
            ) : (
              <>
                <span className="text-sentinel-textDim">{logs.length}</span>
                <span> entries loaded</span>
              </>
            )}
          </div>
        </div>

        {metrics && (
          <div className="px-5 py-3 border-b border-white/[0.05] shrink-0 bg-white/[0.02]">
            <div className="text-[10px] uppercase tracking-wider text-sentinel-textMuted mb-2">Live Metrics</div>
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

        {/* ─── Search input ─────────────────────────────────── */}
        <div className="px-5 py-2.5 border-b border-white/[0.05] shrink-0 flex items-center gap-2">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sentinel-textMuted shrink-0" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search by tool, decision, source, error…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-[12px] text-sentinel-text placeholder:text-sentinel-textMuted outline-none"
            aria-label="Search logs"
          />
          {searchText && (
            <button
              type="button"
              onClick={() => setSearchText('')}
              aria-label="Clear search"
              className="text-sentinel-textMuted hover:text-sentinel-text text-[14px] leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-white/[0.06] transition-colors"
            >
              ×
            </button>
          )}
        </div>

        {/* ─── Logs table ───────────────────────────────────── */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          {logs.length === 0 ? (
            <div className="text-center text-[12px] text-sentinel-textMuted py-12">
              Waiting for AI orchestrator to log events…
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-center text-[12px] text-sentinel-textMuted py-12">
              No logs match the current filters.
              <button
                type="button"
                onClick={() => {
                  setFilter('all')
                  clearDateRange()
                  setSearchText('')
                }}
                className="block mx-auto mt-2 text-sentinel-info hover:underline"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            <table className="w-full text-[12px] border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-[rgba(13,19,36,0.96)] backdrop-blur">
                <tr className="text-[10px] uppercase tracking-wider text-sentinel-textMuted">
                  <th className="text-left font-semibold py-2 px-3 w-[60px] border-b border-white/[0.08]">{/* expand chevron */}</th>
                  <th className="text-left font-semibold py-2 px-3 w-[130px] border-b border-white/[0.08]">Time</th>
                  <th className="text-left font-semibold py-2 px-3 w-[140px] border-b border-white/[0.08]">Event</th>
                  <th className="text-left font-semibold py-2 px-3 w-[180px] border-b border-white/[0.08]">Source / Tool</th>
                  <th className="text-left font-semibold py-2 px-3 border-b border-white/[0.08]">Summary</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log, i) => {
                  const key = `${log.timestamp}-${i}`
                  const expanded = expandedKey === key
                  const summary = summarizeLog(log)
                  const source = sourceOfLog(log)
                  return (
                    <LogTableRow
                      key={key}
                      log={log}
                      expanded={expanded}
                      onToggle={() => setExpandedKey(expanded ? null : key)}
                      summary={summary}
                      source={source}
                      striped={i % 2 === 1}
                    />
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )

  return createPortal(drawer, document.body)
}

const ACCENT_CLASSES = {
  zinc:    'border-white/[0.08] text-sentinel-text',
  emerald: 'border-emerald-700/60 text-emerald-200',
  amber:   'border-amber-700/60 text-amber-200',
  blue:    'border-blue-700/60 text-blue-200',
  red:     'border-red-700/60 text-red-200',
}

function MetricTile({ label, value, accent = 'zinc', hint }) {
  const accentCls = ACCENT_CLASSES[accent] || ACCENT_CLASSES.zinc
  return (
    <div className={`bg-black/40 rounded border ${accentCls} px-2 py-1.5`}>
      <div className="text-[9px] uppercase tracking-wider text-sentinel-textMuted leading-tight">{label}</div>
      <div className="text-[14px] font-semibold leading-tight">{value}</div>
      {hint && <div className="text-[9px] text-sentinel-textMuted leading-tight">{hint}</div>}
    </div>
  )
}

/* ─── Table row + detail panel ─────────────────────────────── */

function LogTableRow({ log, expanded, onToggle, summary, source, striped }) {
  const badgeColor =
    EVENT_COLORS[log.event_type] ||
    'text-sentinel-textDim bg-white/[0.06] border-white/[0.08]'
  return (
    <>
      <tr
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={[
          'cursor-pointer transition-colors',
          expanded
            ? 'bg-sentinel-info/[0.07]'
            : striped
              ? 'bg-white/[0.015] hover:bg-white/[0.04]'
              : 'hover:bg-white/[0.04]',
        ].join(' ')}
      >
        <td className="py-1.5 px-3 align-top border-b border-white/[0.04]">
          <span
            className={`inline-block text-sentinel-textMuted transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </td>
        <td className="py-1.5 px-3 align-top border-b border-white/[0.04] font-mono text-[11px] text-sentinel-textDim tabular whitespace-nowrap">
          {formatTimestamp(log.timestamp)}
        </td>
        <td className="py-1.5 px-3 align-top border-b border-white/[0.04]">
          <span className={`inline-block text-[9px] tracking-wider font-semibold px-1.5 py-0.5 rounded border ${badgeColor}`}>
            {log.event_type}
          </span>
        </td>
        <td className="py-1.5 px-3 align-top border-b border-white/[0.04] text-[11px] text-sentinel-textDim font-mono truncate max-w-[180px]">
          {source || '—'}
        </td>
        <td className="py-1.5 px-3 align-top border-b border-white/[0.04] text-[12px] text-sentinel-text">
          <div className="truncate">{summary}</div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-sentinel-info/[0.04]">
          <td colSpan={5} className="py-3 px-5 border-b border-white/[0.06]">
            <LogDetailPanel log={log} />
          </td>
        </tr>
      )}
    </>
  )
}

function LogDetailPanel({ log }) {
  const d = log.details ?? {}
  return (
    <div className="space-y-3">
      {log.event_type === 'DECISION' && (
        <>
          <DetailField label="Decision" value={d.decision} color="text-blue-300" />
          <DetailField
            label="Rationale"
            value={d.rationale}
            color="text-sentinel-textDim"
            multiline
          />
        </>
      )}
      {log.event_type === 'TOOL_CALL' && (
        <>
          <DetailField label="Tool" value={d.tool_name} color="text-purple-300" mono />
          {d.arguments && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sentinel-textMuted mb-1">Arguments</div>
              <pre className="text-[11px] text-sentinel-textDim leading-relaxed overflow-x-auto p-2 bg-black/40 rounded border border-white/[0.06] font-mono">
                {JSON.stringify(d.arguments, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
      {log.event_type === 'OBSERVATION' && (
        <>
          <DetailField label="Source" value={d.source} color="text-green-300" mono />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-sentinel-textMuted mb-1">Data</div>
            {typeof d.data === 'string' ? (
              <div className="text-[12px] text-sentinel-text whitespace-pre-wrap leading-relaxed">
                {d.data}
              </div>
            ) : (
              <pre className="text-[11px] text-sentinel-textDim leading-relaxed overflow-x-auto p-2 bg-black/40 rounded border border-white/[0.06] font-mono">
                {JSON.stringify(d.data, null, 2)}
              </pre>
            )}
          </div>
        </>
      )}
      {log.event_type === 'RECOVERY_ACTION' && (
        <>
          <DetailField label="Problem" value={d.error_context} color="text-red-300" multiline />
          <DetailField label="Action" value={d.action_taken} color="text-sentinel-text" multiline />
          {d.agent_id && (
            <DetailField label="Agent" value={d.agent_id} color="text-sentinel-textMuted" mono />
          )}
        </>
      )}
      {!['DECISION', 'TOOL_CALL', 'OBSERVATION', 'RECOVERY_ACTION'].includes(log.event_type) && (
        <pre className="text-[11px] text-sentinel-textDim leading-relaxed overflow-x-auto p-2 bg-black/40 rounded border border-white/[0.06] font-mono">
          {JSON.stringify(d, null, 2)}
        </pre>
      )}
    </div>
  )
}

function DetailField({ label, value, color = 'text-sentinel-text', mono = false, multiline = false }) {
  if (!value) return null
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-sentinel-textMuted mb-1">{label}</div>
      <div
        className={[
          `text-[12px] leading-relaxed ${color}`,
          mono ? 'font-mono' : '',
          multiline ? 'whitespace-pre-wrap' : '',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  )
}

/* ─── Log shape helpers ────────────────────────────────────── */

function summarizeLog(log) {
  const d = log.details ?? {}
  switch (log.event_type) {
    case 'DECISION':
      return d.decision || d.rationale || '—'
    case 'TOOL_CALL':
      return d.tool_name
        ? `${d.tool_name}(${argsPreview(d.arguments)})`
        : '—'
    case 'OBSERVATION':
      if (typeof d.data === 'string') {
        return d.data.length > 120 ? d.data.slice(0, 120) + '…' : d.data
      }
      return d.data ? 'Structured payload' : '—'
    case 'RECOVERY_ACTION':
      return d.error_context || d.action_taken || '—'
    default:
      return JSON.stringify(d).slice(0, 160)
  }
}

function sourceOfLog(log) {
  const d = log.details ?? {}
  if (log.event_type === 'TOOL_CALL') return d.tool_name
  if (log.event_type === 'OBSERVATION') return d.source
  if (log.event_type === 'RECOVERY_ACTION') return d.agent_id
  return null
}

function argsPreview(args) {
  if (args == null) return ''
  if (typeof args !== 'object') return String(args)
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '')
}

function formatTimestamp(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(Math.floor(d.getMilliseconds() / 10))}`
}
