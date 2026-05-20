import { useEffect, useRef, useState, useCallback } from 'react'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

// How often we poll the server for the latest target weather.
const POLL_MS = 1000
// How often we re-render with eased values; 5 ticks/s reads as smooth.
const TICK_MS = 200
// Exponential-ramp time-constant (seconds). With tau=20 the displayed value
// covers ~63% of the gap in 20 s and ~95% in 60 s — feels "slowly rising"
// without being so slow operators think it's frozen.
const TAU_S = 20
// When a fading region's temperature is within this many °C of baseline, drop
// it from the list. (Below this, the lerp would take forever to fully resolve.)
const FADE_REMOVE_C = 0.2
// While temperature is still this far from target (°C), keep the previous
// icon/label/condition so we don't snap to "Clear ☀️ 35°C" while ramping down.
const LABEL_HYSTERESIS_C = 1.0

// Numeric fields we ease over time. Everything else (icon, label, condition,
// detail, alerts, driver) swaps to the latest target immediately, except where
// LABEL_HYSTERESIS_C overrides for the cosmetic header.
const LERP_FIELDS = [
  'temperature_c', 'dew_point_c', 'humidity_pct',
  'precipitation_mm_per_hour', 'wind_speed_kph', 'wind_direction_deg',
  'pressure_hpa', 'air_quality_aqi', 'visibility_km',
]

function easeWeather(current, target, dt, seed = null) {
  if (!target) return current
  // First sight of this region/global. If we have a seed (baseline), use its
  // numeric values as the starting point so the next tick produces a visible
  // ramp from baseline → target. Without a seed we'd snap to target and the
  // operator would never see the rise/fall.
  if (!current) {
    const out = { ...target }
    if (seed) {
      for (const k of LERP_FIELDS) {
        const s = seed[k]
        if (typeof s === 'number') out[k] = s
      }
    }
    return out
  }
  const factor = 1 - Math.exp(-dt / TAU_S)
  const out = { ...target }
  let tempGap = 0
  for (const k of LERP_FIELDS) {
    const c = current[k]
    const t = target[k]
    if (typeof c !== 'number' || typeof t !== 'number') {
      if (typeof c === 'number' && typeof t !== 'number') out[k] = c
      continue
    }
    const eased = c + (t - c) * factor
    out[k] = eased
    if (k === 'temperature_c') tempGap = Math.abs(t - eased)
  }
  // Cosmetic hysteresis: while temperature is still mid-ramp, keep the
  // previous icon/label so the operator doesn't see "Clear ☀️" pinned on a
  // 40°C readout while it eases down.
  if (tempGap > LABEL_HYSTERESIS_C && current.label) {
    out.icon = current.icon
    out.label = current.label
    out.condition = current.condition
    out.detail = current.detail
  }
  return out
}

function roundForDisplay(w) {
  if (!w) return w
  const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)
  const r0 = (v) => (typeof v === 'number' ? Math.round(v) : v)
  return {
    ...w,
    temperature_c: r1(w.temperature_c),
    dew_point_c: r1(w.dew_point_c),
    precipitation_mm_per_hour: r1(w.precipitation_mm_per_hour),
    visibility_km: r1(w.visibility_km),
    humidity_pct: r0(w.humidity_pct),
    wind_speed_kph: r0(w.wind_speed_kph),
    wind_direction_deg: r0(w.wind_direction_deg),
    pressure_hpa: r0(w.pressure_hpa),
    air_quality_aqi: r0(w.air_quality_aqi),
  }
}

export function useWeather() {
  // Latest target snapshot from the server. The smoothing loop reads this via
  // ref so polling updates don't restart the tick interval.
  const targetRef = useRef({ global: null, regions: [], baseline: null })
  // Smoothed values exposed to the UI.
  const [weather, setWeather] = useState(null)
  const [regions, setRegions] = useState([])
  const [baseline, setBaseline] = useState(null)
  // Accumulator across ticks: kept as raw floats here, rounded only at render.
  const easedRef = useRef({ global: null, byId: new Map() })
  const lastTickRef = useRef(Date.now())
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/weather/regions`)
      if (!res.ok) return
      const json = await res.json()
      if (!aliveRef.current) return
      targetRef.current = {
        global: json.global ?? null,
        regions: Array.isArray(json.regions) ? json.regions : [],
        baseline: json.baseline ?? null,
      }
      setBaseline(json.baseline ?? null)
    } catch {
      /* offline / backend down — keep last value */
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    refresh()
    const pollId = setInterval(refresh, POLL_MS)

    const tickId = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now

      const tgt = targetRef.current
      const baselineW = tgt.baseline

      // ── Global summary ──
      // When no disaster bends weather, the server returns baseline as global,
      // so the same lerp path eases the chip back to ambient automatically.
      const globalTarget = tgt.global ?? baselineW
      const newGlobal = easeWeather(easedRef.current.global, globalTarget, dt, baselineW)
      easedRef.current.global = newGlobal

      // ── Regions ──
      const liveById = new Map(
        tgt.regions.filter((r) => r && r.event_id).map((r) => [r.event_id, r]),
      )
      const next = new Map()
      // Ease live regions toward their server target. Seed = baseline so the
      // first sight of a new region starts at ambient and ramps up/down
      // visibly over the next ~60 s instead of snapping to target.
      for (const [id, region] of liveById) {
        const prev = easedRef.current.byId.get(id)
        const easedW = easeWeather(prev?.weather, region.weather, dt, baselineW)
        next.set(id, { ...region, weather: easedW })
      }
      // Ease cleared regions toward baseline until they're close enough to
      // drop. They keep their last geometry/centroid so the map polygon
      // fades down rather than vanishing the moment the disaster ends.
      if (baselineW) {
        for (const [id, prev] of easedRef.current.byId) {
          if (liveById.has(id)) continue
          if (!prev?.weather) continue
          const easedW = easeWeather(prev.weather, baselineW, dt)
          const tempC = easedW.temperature_c
          const baseC = baselineW.temperature_c
          const settled =
            typeof tempC === 'number' &&
            typeof baseC === 'number' &&
            Math.abs(tempC - baseC) < FADE_REMOVE_C
          if (settled) continue
          next.set(id, { ...prev, weather: easedW, cleared: true })
        }
      }

      easedRef.current.byId = next

      setWeather(roundForDisplay(newGlobal))
      setRegions(
        Array.from(next.values()).map((r) => ({
          ...r,
          weather: roundForDisplay(r.weather),
        })),
      )
    }, TICK_MS)

    return () => {
      aliveRef.current = false
      clearInterval(pollId)
      clearInterval(tickId)
    }
  }, [refresh])

  return { weather, regions, baseline, refresh }
}
