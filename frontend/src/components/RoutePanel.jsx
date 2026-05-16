function formatDistance(m) {
  if (!m) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function formatDuration(s) {
  if (!s) return '—'
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}m`
}

function formatCoord(point) {
  if (!point) return 'Pick on map'
  return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`
}

function WaypointRow({ label, dotColor, point, isPicking, onPick, onClear }) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onPick}
        className={[
          'flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-left text-[12px] transition-colors',
          isPicking
            ? 'border-emerald-600 bg-emerald-950/40 text-zinc-100'
            : point
              ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600'
              : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300',
        ].join(' ')}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: dotColor }}
        />
        <span className="text-[11px] font-medium text-zinc-400 shrink-0 w-7">
          {label}
        </span>
        <span className="truncate tabular-nums">
          {isPicking ? 'Click on the map…' : formatCoord(point)}
        </span>
      </button>
      {point && !isPicking && (
        <button
          onClick={onClear}
          className="text-zinc-600 hover:text-red-400 text-[14px] leading-none w-5 h-5 flex items-center justify-center transition-colors"
          title="Clear waypoint"
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function RoutePanel({
  waypoints,
  waypointMode,
  onPickMode,
  onClearWaypoint,
  onClearAll,
  route,
  loading,
  error,
}) {
  const hasAny = waypoints.start || waypoints.end
  const summary = route
    ? `${formatDistance(route.distanceMeters)} · ${formatDuration(route.durationSeconds)}`
    : null

  return (
    <div className="space-y-2">
      <WaypointRow
        label="Start"
        dotColor="#10b981"
        point={waypoints.start}
        isPicking={waypointMode === 'start'}
        onPick={() => onPickMode(waypointMode === 'start' ? null : 'start')}
        onClear={() => onClearWaypoint('start')}
      />
      <WaypointRow
        label="End"
        dotColor="#ef4444"
        point={waypoints.end}
        isPicking={waypointMode === 'end'}
        onPick={() => onPickMode(waypointMode === 'end' ? null : 'end')}
        onClear={() => onClearWaypoint('end')}
      />

      {(loading || error || summary) && (
        <div className="px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900 text-[11px]">
          {loading && (
            <span className="inline-flex items-center gap-2 text-zinc-400">
              <span className="w-3 h-3 border-2 border-zinc-600 border-t-zinc-200 rounded-full animate-spin" />
              Computing route…
            </span>
          )}
          {!loading && error && (
            <span className="text-red-400 break-words">{error}</span>
          )}
          {!loading && !error && summary && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-300 tabular-nums">{summary}</span>
              <span className="text-zinc-600">via Valhalla</span>
            </div>
          )}
        </div>
      )}

      {hasAny && (
        <button
          onClick={onClearAll}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Clear route
        </button>
      )}
    </div>
  )
}
