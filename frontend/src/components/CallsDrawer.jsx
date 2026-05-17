// Slide-up panel anchored over the map area (left edge clears the sidebar).
// Presentational: parent owns the reports array and lifecycle.

const KIND_LABEL = {
  observation: 'OBSERVED',
  affected: 'AFFECTED',
}

const KIND_COLORS = {
  observation: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
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
    <div
      className={[
        'absolute left-[360px] right-0 bottom-0 z-40 transition-transform duration-300 ease-out',
        open ? 'translate-y-0' : 'translate-y-full',
      ].join(' ')}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
    >
      <div className="bg-zinc-950/95 backdrop-blur border-t border-zinc-800 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] flex flex-col max-h-[55vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold text-zinc-100">911 Calls</h2>
            <span className="text-[11px] text-zinc-500 tabular-nums">{filtered.length} / {reports.length} total</span>
          </div>
          <div className="flex items-center gap-1.5">
            {['all', 'observation', 'affected'].map((k) => (
              <button
                key={k}
                onClick={() => onFilterChange?.(k)}
                className={[
                  'px-2.5 py-1 text-[11px] rounded transition-colors',
                  filter === k
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300',
                ].join(' ')}
              >
                {k === 'all' ? 'All' : k === 'observation' ? 'Observed' : 'Affected'}
              </button>
            ))}
            <span className="w-px h-4 bg-zinc-800 mx-1" />
            <button
              onClick={onClear}
              disabled={reports.length === 0}
              className="text-[11px] text-zinc-500 hover:text-red-400 disabled:text-zinc-700 disabled:cursor-not-allowed px-2 py-1 transition-colors"
              title="Clear all visible calls"
            >
              Clear
            </button>
            <span className="w-px h-4 bg-zinc-800" />
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200 px-2 text-[14px] leading-none transition-colors"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {filtered.length === 0 ? (
            <div className="text-center text-[12px] text-zinc-600 py-6">
              No calls yet. Drop a disaster on the map and watch the citizens react.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-3 px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 transition-colors cursor-pointer"
                  onClick={() => onReportClick?.(r)}
                >
                  <span className="font-mono text-[10px] text-zinc-600 tabular-nums w-16 shrink-0 pt-0.5">
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
                    <div className="text-[12px] text-zinc-200 leading-snug break-words">
                      {r.transcript}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-0.5 tabular-nums">
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
    </div>
  )
}
