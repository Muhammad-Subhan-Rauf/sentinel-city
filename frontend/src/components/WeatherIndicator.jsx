// Compact global-weather chip. Just the headline (condition + temperature)
// with an alert pill if any authority alert is active. Detailed per-region
// stats live in the WeatherRegionsPanel below this chip — no dropdown here,
// since opening one would cover those cards.

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

export default function WeatherIndicator({ weather }) {
  if (!weather) return null
  const { icon, label, temperature_c, alerts = [], detail } = weather
  const topAlert = alerts[0]

  return (
    <div
      className="inline-flex items-center gap-2 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] text-zinc-200"
      title={detail}
    >
      <span className="text-base leading-none" aria-hidden>{icon}</span>
      <span className="font-medium">{label}</span>
      <span className="text-zinc-500 tabular-nums">{temperature_c}°C</span>
      {topAlert && (
        <span
          className={`ml-1 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] leading-none ${ALERT_TONE[topAlert.severity] || ALERT_TONE.minor}`}
          title={topAlert.headline}
        >
          {ALERT_LABEL[topAlert.type] || topAlert.type}
          {alerts.length > 1 && <span className="ml-1 opacity-70">+{alerts.length - 1}</span>}
        </span>
      )}
    </div>
  )
}
