// Slide-up panel anchored over the map area (left edge clears the sidebar).
// Presentational: parent owns the reports array and lifecycle.

import { AnimatePresence, motion } from 'framer-motion'

const KIND_LABEL = {
  observation: 'OBSERVED',
  affected: 'AFFECTED',
}

const KIND_COLORS = {
  observation: 'text-sentinel-warn bg-sentinel-warn/10 border-sentinel-warn/30',
  affected: 'text-pink-400 bg-pink-500/10 border-pink-500/30',
}

function formatTime(t) {
  try {
    return new Date(t).toLocaleTimeString('en-US', { hour12: false })
  } catch {
    return ''
  }
}

export default function CallsDrawer({
  open,
  reports = [],
  filter = 'all',
  onFilterChange,
  onClose,
  onClear,
  onReportClick,
  typeIconLookup,
}) {
  const filtered = reports.filter((r) => filter === 'all' || r.report_kind === filter)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id="calls-drawer"
          role="dialog"
          aria-label="911 calls"
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '100%', opacity: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="absolute left-[360px] right-0 bottom-0 z-40"
          style={{ willChange: 'transform' }}
        >
          <div className="glass-strong border-t border-white/[0.06] rounded-t-2xl flex flex-col max-h-[55vh] shadow-[0_-20px_60px_rgba(0,0,0,0.6)]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05]">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold text-sentinel-text">911 Calls</h2>
            <span className="text-[11px] text-sentinel-textMuted tabular-nums">{filtered.length} / {reports.length} total</span>
          </div>
          <div className="flex items-center gap-1.5">
            {['all', 'observation', 'affected'].map((k) => (
              <button
                key={k}
                onClick={() => onFilterChange?.(k)}
                className={[
                  'px-2.5 py-1 text-[11px] rounded transition-colors',
                  filter === k
                    ? 'bg-white/[0.06] text-sentinel-text'
                    : 'text-sentinel-textMuted hover:text-sentinel-text',
                ].join(' ')}
              >
                {k === 'all' ? 'All' : k === 'observation' ? 'Observed' : 'Affected'}
              </button>
            ))}
            <span className="w-px h-4 bg-white/[0.06] mx-1" />
            <button
              onClick={onClear}
              disabled={reports.length === 0}
              className="text-[11px] text-sentinel-textMuted hover:text-red-400 disabled:text-sentinel-textMuted disabled:cursor-not-allowed px-2 py-1 transition-colors"
              title="Clear all visible calls"
            >
              Clear
            </button>
            <span className="w-px h-4 bg-white/[0.06]" />
            <button
              onClick={onClose}
              className="text-sentinel-textMuted hover:text-sentinel-text px-2 text-[14px] leading-none transition-colors"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {filtered.length === 0 ? (
            <div className="text-center text-[12px] text-sentinel-textMuted py-6">
              No calls yet. Drop a disaster on the map and watch the citizens react.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-3 px-3 py-2 rounded-md border border-white/[0.05] bg-white/[0.03] hover:bg-white/[0.02] transition-colors cursor-pointer"
                  onClick={() => onReportClick?.(r)}
                >
                  <span className="font-mono text-[10px] text-sentinel-textMuted tabular-nums w-16 shrink-0 pt-0.5">
                    {formatTime(r.reported_at)}
                  </span>
                  <span
                    className={[
                      'text-[9px] tracking-wider font-semibold px-1.5 py-0.5 rounded border shrink-0 mt-0.5',
                      KIND_COLORS[r.report_kind] || KIND_COLORS.observation,
                    ].join(' ')}
                  >
                    {KIND_LABEL[r.report_kind] || r.report_kind.toUpperCase()}
                  </span>
                  {typeIconLookup && r.event_type && (
                    <span className="text-base leading-none shrink-0 mt-0.5">
                      {typeIconLookup(r.event_type)}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-sentinel-text leading-snug break-words">
                      {r.transcript}
                    </div>
                    <div className="text-[10px] text-sentinel-textMuted mt-0.5 tabular-nums">
                      Citizen #{r.citizen_idx}
                      {r.perceived_severity != null && (
                        <> · Severity {r.perceived_severity}</>
                      )}
                      {r.location && (
                        <> · {r.location.lat.toFixed(4)}, {r.location.lng.toFixed(4)}</>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
