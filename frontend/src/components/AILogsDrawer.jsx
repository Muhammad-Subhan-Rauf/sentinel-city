import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

const EVENT_COLORS = {
  DECISION: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  TOOL_CALL: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  OBSERVATION: 'text-green-400 bg-green-500/10 border-green-500/30',
  RECOVERY_ACTION: 'text-red-400 bg-red-500/10 border-red-500/30',
}

export default function AILogsDrawer({
  open,
  onClose,
  backendUrl
}) {
  const [logs, setLogs] = useState([])
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!open) return

    let active = true
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/logs?limit=50`)
        if (!res.ok) return
        const data = await res.json()
        if (active) setLogs(data.logs || [])
      } catch (err) {
        console.error("Failed to fetch logs", err)
      }
    }

    fetchLogs()
    const intervalId = setInterval(fetchLogs, 3000)

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [open, backendUrl])

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
            </select>
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
