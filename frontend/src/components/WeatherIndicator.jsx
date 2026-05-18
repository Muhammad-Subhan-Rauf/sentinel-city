export default function WeatherIndicator({ weather }) {
  if (!weather) return null
  const { icon, label, temperature_c } = weather
  return (
    <div
      className="inline-flex items-center gap-2 bg-zinc-900/95 backdrop-blur border border-zinc-800 rounded-md px-3 py-1.5 text-[12px] text-zinc-200"
      title={weather.detail}
    >
      <span className="text-base leading-none" aria-hidden>{icon}</span>
      <span className="font-medium">{label}</span>
      <span className="text-zinc-500 tabular-nums">{temperature_c}°C</span>
    </div>
  )
}
