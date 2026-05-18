import { useEffect, useRef, useState, useCallback } from 'react'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''
const REFRESH_MS = 1000

export function useWeather() {
  const [weather, setWeather] = useState(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/weather`)
      if (!res.ok) return
      const json = await res.json()
      if (aliveRef.current) setWeather(json)
    } catch {
      /* offline / backend down — keep last value */
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => {
      aliveRef.current = false
      clearInterval(id)
    }
  }, [refresh])

  return { weather, refresh }
}
