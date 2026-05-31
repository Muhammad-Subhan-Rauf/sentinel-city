import { useState } from 'react'
import { MAX_FIRE_STATIONS, MAX_HOSPITALS, MAX_POLICE_STATIONS } from '../lib/config'

// Hidden settings drawer for deployment config: fire stations, hospitals,
// and police stations. Each section is a copy of the same UX so the operator
// only learns one pattern.
//
// When onXPlacementToggle(true) fires, MapView enters a placement mode where
// the next click drops a marker of the matching kind.

function StationSection({
  title, icon, max, stations, placementMode,
  pendingName, setPendingName,
  pendingCapacity, setPendingCapacity,
  capacityLabel, defaultCapacity,
  onPlacementToggle, onRemove, onCapacityChange,
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium text-sentinel-text">{title}</span>
        <span className="text-[10px] text-sentinel-textMuted tabular-nums">{stations.length} / {max}</span>
      </div>

      <div className="space-y-1 mb-2 max-h-[220px] overflow-y-auto">
        {stations.length === 0 ? (
          <div className="px-2.5 py-2 rounded border border-white/[0.05] bg-black/30 text-[10px] text-sentinel-textMuted">
            No {title.toLowerCase()} placed yet. Click "Place on map" then click a point on the map.
          </div>
        ) : (
          stations.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-white/[0.05] bg-black/30 text-[11px]">
              <span className="leading-none">{icon}</span>
              <div className="flex-1 min-w-0">
                <div className="truncate text-sentinel-text">{s.name || title}</div>
                <div className="text-[10px] text-sentinel-textMuted tabular-nums">
                  {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                </div>
                {onCapacityChange && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={capacityValue(s, capacityLabel)}
                      onBlur={(e) => {
                        const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0))
                        if (v !== capacityValue(s, capacityLabel)) onCapacityChange(s.id, v)
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      className="w-12 bg-white/[0.02] border border-white/[0.05] rounded px-1 py-0 text-[10px] text-sentinel-text tabular-nums focus:outline-none focus:border-white/[0.12]"
                    />
                    <span className="text-[10px] text-sentinel-textMuted">{capacityLabel}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => onRemove(s.id)}
                className="text-sentinel-textMuted hover:text-red-400 text-[14px] w-5 h-5 flex items-center justify-center rounded"
                title="Remove"
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
        placeholder="Name (optional)"
        disabled={stations.length >= max}
        className="w-full bg-white/[0.02] border border-white/[0.05] rounded px-2 py-1 text-[11px] text-sentinel-text placeholder:text-sentinel-textMuted focus:outline-none focus:border-white/[0.12] mb-1.5 disabled:opacity-50"
      />
      <div className="flex items-center gap-2 mb-1.5">
        <label className="text-[11px] text-sentinel-textDim whitespace-nowrap">{capacityLabel}</label>
        <input
          type="number"
          min={0}
          max={100}
          value={pendingCapacity}
          onChange={(e) => setPendingCapacity(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
          disabled={stations.length >= max}
          className="w-16 bg-white/[0.02] border border-white/[0.05] rounded px-2 py-0.5 text-[11px] text-sentinel-text tabular-nums focus:outline-none focus:border-white/[0.12] disabled:opacity-50"
        />
        <span className="text-[10px] text-sentinel-textMuted">(default {defaultCapacity})</span>
      </div>
      <button
        onClick={() => onPlacementToggle(!placementMode, pendingName.trim() || null, pendingCapacity)}
        disabled={stations.length >= max}
        className={[
          'w-full py-1.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
          placementMode
            ? 'bg-amber-500/30 text-amber-100 border border-amber-500/60'
            : 'bg-white/[0.06] hover:bg-white/[0.1] text-sentinel-text',
        ].join(' ')}
      >
        {placementMode ? 'Click on map to place… (cancel)' : '+ Place on map'}
      </button>
    </section>
  )
}

function capacityValue(station, label) {
  if (label === 'trucks') return station.truck_count ?? 0
  if (label === 'ambulances') return station.ambulance_count ?? 0
  if (label === 'officers') return station.police_count ?? 0
  return 0
}

export default function SettingsPanel({
  open,
  onClose,
  // Fire stations
  stations,
  placementMode,
  onStationPlacementToggle,
  onStationRemove,
  onStationCapacityChange,
  // Hospitals
  hospitals,
  hospitalPlacementMode,
  onHospitalPlacementToggle,
  onHospitalRemove,
  onHospitalCapacityChange,
  // Police stations
  policeStations,
  policePlacementMode,
  onPolicePlacementToggle,
  onPoliceRemove,
  onPoliceCapacityChange,
}) {
  const [pendingName, setPendingName] = useState('')
  const [pendingCapacity, setPendingCapacity] = useState(4)
  const [pendingHospitalName, setPendingHospitalName] = useState('')
  const [pendingHospitalCapacity, setPendingHospitalCapacity] = useState(3)
  const [pendingPoliceName, setPendingPoliceName] = useState('')
  const [pendingPoliceCapacity, setPendingPoliceCapacity] = useState(10)

  if (!open) return null

  return (
    <div className="absolute top-16 right-4 z-40 w-[320px] glass-strong backdrop-blur border border-white/[0.08] rounded-md text-sentinel-text shadow-xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <h3 className="text-[12px] font-semibold tracking-tight">Settings</h3>
        <button onClick={onClose} className="text-sentinel-textMuted hover:text-sentinel-text text-[14px] leading-none">×</button>
      </div>

      <div className="p-3 space-y-4 max-h-[80vh] overflow-y-auto">
        <StationSection
          title="Fire stations"
          icon="🚒"
          max={MAX_FIRE_STATIONS}
          stations={stations || []}
          placementMode={placementMode}
          pendingName={pendingName}
          setPendingName={setPendingName}
          pendingCapacity={pendingCapacity}
          setPendingCapacity={setPendingCapacity}
          capacityLabel="trucks"
          defaultCapacity={4}
          onPlacementToggle={onStationPlacementToggle}
          onRemove={onStationRemove}
          onCapacityChange={onStationCapacityChange}
        />

        <StationSection
          title="Hospitals"
          icon="🏥"
          max={MAX_HOSPITALS}
          stations={hospitals || []}
          placementMode={hospitalPlacementMode}
          pendingName={pendingHospitalName}
          setPendingName={setPendingHospitalName}
          pendingCapacity={pendingHospitalCapacity}
          setPendingCapacity={setPendingHospitalCapacity}
          capacityLabel="ambulances"
          defaultCapacity={3}
          onPlacementToggle={onHospitalPlacementToggle}
          onRemove={onHospitalRemove}
          onCapacityChange={onHospitalCapacityChange}
        />

        <StationSection
          title="Police stations"
          icon="🚓"
          max={MAX_POLICE_STATIONS}
          stations={policeStations || []}
          placementMode={policePlacementMode}
          pendingName={pendingPoliceName}
          setPendingName={setPendingPoliceName}
          pendingCapacity={pendingPoliceCapacity}
          setPendingCapacity={setPendingPoliceCapacity}
          capacityLabel="officers"
          defaultCapacity={10}
          onPlacementToggle={onPolicePlacementToggle}
          onRemove={onPoliceRemove}
          onCapacityChange={onPoliceCapacityChange}
        />
      </div>
    </div>
  )
}
