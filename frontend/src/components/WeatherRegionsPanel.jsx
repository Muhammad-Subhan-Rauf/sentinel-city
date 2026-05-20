// Right-side stack of weather cards — one per active disaster region.
// Each card carries a numbered badge that matches the badge on the map, so
// operators can correlate the panel row with its footprint visually.

const ALERT_TONE = {
  minor:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  moderate: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  severe:   'bg-red-500/15 text-red-300 border-red-500/30',
  extreme:  'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
}

const ALERT_LABEL = {
  heat: 'Heat',
  flood: 'Flood',
  tornado: 'Tornado',
  severe_thunderstorm: 'Severe T-Storm',
  air_quality: 'Air Quality',
  freeze: 'Freeze',
  wind: 'Wind',
}

function tone(temperatureC, condition, bendsWeather) {
  if (bendsWeather === false) return '#a1a1aa'
  if (condition === 'severe_storm' || condition === 'heavy_rain') return '#2563eb'
  if (condition === 'light_rain') return '#38bdf8'
  if (condition === 'freezing') return '#60a5fa'
  if (typeof temperatureC !== 'number') return '#71717a'
  if (temperatureC <= 0) return '#1e3a8a'
  if (temperatureC <= 10) return '#0ea5e9'
  if (temperatureC <= 20) return '#22c55e'
  if (temperatureC <= 28) return '#facc15'
  if (temperatureC <= 36) return '#f97316'
  if (temperatureC <= 45) return '#ef4444'
  return '#b91c1c'
}

function Row({ label, value, suffix = '' }) {
  if (value === null || value === undefined) return null
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 tabular-nums">{value}{suffix}</span>
    </div>
  )
}

function ZoneCard({ region }) {
  const w = region.weather || {}
  const colour = tone(w.temperature_c, w.condition, region.bends_weather !== false)
  const num = region.zone_number ?? '·'
  const alerts = Array.isArray(w.alerts) ? w.alerts : []
  const cleared = region.cleared === true
  return (
    <div
      className={[
        'border-b border-zinc-800 last:border-b-0 px-3 py-3 transition-opacity',
        cleared ? 'opacity-55' : 'opacity-100',
      ].join(' ')}
    >
      <div className="flex items-start gap-2 mb-2">
        <span
          className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-bold leading-none flex-shrink-0"
          style={{
            background: 'rgba(9,9,11,0.92)',
            border: `2px solid ${colour}`,
            color: colour,
          }}
        >
          {num}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-zinc-100 font-medium truncate">
            {region.disaster_type} · sev {region.severity}
            {cleared && <span className="ml-1 text-amber-400 text-[10px]">(clearing)</span>}
          </div>
          <div className="text-[10px] text-zinc-500 leading-snug truncate" title={w.detail}>
            {w.label}
          </div>
        </div>
        <span className="text-base leading-none flex-shrink-0" aria-hidden>{w.icon}</span>
      </div>

      <div className="space-y-0.5">
        <Row label="Temperature" value={w.temperature_c} suffix=" °C" />
        <Row label="Dew point" value={w.dew_point_c} suffix=" °C" />
        <Row label="Humidity" value={w.humidity_pct} suffix=" %" />
        <Row label="Precipitation" value={w.precipitation_mm_per_hour} suffix=" mm/h" />
        <Row
          label="Wind"
          value={w.wind_speed_kph != null ? `${w.wind_speed_kph} kph @ ${w.wind_direction_deg ?? 0}°` : null}
        />
        <Row label="Pressure" value={w.pressure_hpa} suffix=" hPa" />
        <Row label="Visibility" value={w.visibility_km} suffix=" km" />
        <Row label="Air quality" value={w.air_quality_aqi} suffix=" AQI" />
      </div>

      {alerts.length > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-800 space-y-1">
          <div className="text-[9px] uppercase tracking-wide text-zinc-500">Active alerts</div>
          {alerts.map((a) => (
            <div
              key={a.id}
              className={`flex items-start gap-2 rounded border px-2 py-1 text-[10px] ${ALERT_TONE[a.severity] || ALERT_TONE.minor}`}
            >
              <span className="font-semibold uppercase tracking-wide flex-shrink-0">
                {ALERT_LABEL[a.type] || a.type}
              </span>
              <span className="opacity-80 leading-snug">{a.headline}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function WeatherRegionsPanel({ regions = [], onClearAll }) {
  // Hide citywide-only entries (they don't get a map badge, so the operator
  // has no number to correlate with).
  const visible = regions.filter((r) => r && r.scope !== 'city' && r.event_id)
  if (visible.length === 0) return null

  // Stable order by assigned zone number so the panel doesn't shuffle each
  // tick as severity / created_at shift backend ordering.
  const sorted = [...visible].sort((a, b) => {
    const an = a.zone_number ?? Number.POSITIVE_INFINITY
    const bn = b.zone_number ?? Number.POSITIVE_INFINITY
    return an - bn
  })

  return (
    <div className="w-72 max-h-[60vh] overflow-y-auto bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md shadow-xl">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 bg-zinc-900/95 backdrop-blur border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
            Weather Zones
          </span>
          <span className="text-[10px] text-zinc-500 tabular-nums">{sorted.length}</span>
        </div>
        {onClearAll && (
          <button
            type="button"
            onClick={onClearAll}
            className="text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/30 hover:border-red-400/60 rounded px-2 py-0.5 transition-colors"
            title="Wipes every disaster — drafts and active — locally and on the server."
          >
            Clear all
          </button>
        )}
      </div>
      {sorted.map((r) => (
        <ZoneCard key={r.event_id} region={r} />
      ))}
    </div>
  )
}
