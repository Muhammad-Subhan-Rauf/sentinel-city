import { useState } from 'react'
import { MAX_FIRE_STATIONS } from '../lib/config'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

// Hidden settings drawer for one-time deployment-config items: fire stations
// today, more later. Opens from a gear button in the top-right map overlay.
//
// When `onStationPlacementToggle(true)` fires, MapView enters a special mode
// where the next click on the map drops a station marker via `onStationPlace`.
export default function SettingsPanel({
  open,
  onClose,
  stations,
  placementMode,
  onStationPlacementToggle,
  onStationRemove,
}) {
  const [pendingName, setPendingName] = useState('')

  if (!open) return null

  return (
    <div className="absolute top-16 right-4 z-40 w-[300px] bg-zinc-900/98 backdrop-blur border border-zinc-700 rounded-md text-zinc-200 shadow-xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h3 className="text-[12px] font-semibold tracking-tight">Settings</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-[14px] leading-none">×</button>
      </div>

      <div className="p-3 space-y-3">
        <section>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-zinc-300">Fire stations</span>
            <span className="text-[10px] text-zinc-500 tabular-nums">{stations.length} / {MAX_FIRE_STATIONS}</span>
          </div>

          <div className="space-y-1 mb-2 max-h-[180px] overflow-y-auto">
            {stations.length === 0 ? (
              <div className="px-2.5 py-2 rounded border border-zinc-800 bg-zinc-950 text-[10px] text-zinc-500">
                No stations placed yet. Click "Place on map" then click a point on the map.
              </div>
            ) : (
              stations.map((s) => (
                <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-800 bg-zinc-950 text-[11px]">
                  <span className="leading-none">🚒</span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-zinc-200">{s.name || 'Station'}</div>
                    <div className="text-[10px] text-zinc-500 tabular-nums">
                      {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                    </div>
                  </div>
                  <button
                    onClick={() => onStationRemove(s.id)}
                    className="text-zinc-600 hover:text-red-400 text-[14px] w-5 h-5 flex items-center justify-center rounded"
                    title="Remove station"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          <input
            type="text"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            placeholder="Station name (optional)"
            disabled={stations.length >= MAX_FIRE_STATIONS}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 mb-1.5 disabled:opacity-50"
          />
          <button
            onClick={() => onStationPlacementToggle(!placementMode, pendingName.trim() || null)}
            disabled={stations.length >= MAX_FIRE_STATIONS}
            className={[
              'w-full py-1.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              placementMode
                ? 'bg-amber-500/30 text-amber-100 border border-amber-500/60'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200',
            ].join(' ')}
          >
            {placementMode ? 'Click on map to place… (cancel)' : '+ Place on map'}
          </button>
        </section>
      </div>
    </div>
  )
}
