// Type-aware severity input. Reads min/max/labels from DISASTER_PROFILES.
// Shows tick marks at each integer; the active label appears beside the number.

import { getProfile, severityColor } from '../lib/disasterProfiles'

export default function SeveritySelector({ type, value, onChange }) {
  const profile = getProfile(type)
  const sev = profile?.severity
  const min = sev?.min ?? 1
  const max = sev?.max ?? 10
  const labels = sev?.labels ?? []
  const safeValue = Math.max(min, Math.min(max, value))
  const pct = max === min ? 100 : ((safeValue - min) / (max - min)) * 100
  const color = severityColor(type, safeValue)
  const activeLabel = labels[safeValue - min] || ''

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[12px] font-medium text-sentinel-text">Severity</h2>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium tabular-nums" style={{ color }}>
            {safeValue}
          </span>
          {activeLabel && (
            <span className="text-[11px] text-sentinel-textMuted">{activeLabel}</span>
          )}
        </div>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={safeValue}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--range-pct': `${pct}%`, '--range-color': color }}
      />

      <div className="flex justify-between mt-1.5 text-[10px] text-sentinel-textMuted tabular-nums">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </section>
  )
}
