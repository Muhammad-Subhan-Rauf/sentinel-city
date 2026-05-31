import { useEffect, useRef, useState } from 'react'

const CACHE_KEY = 'sentinel:nominatim:v1'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEBOUNCE_MS = 500

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // quota or storage unavailable — fail silently
  }
}

function getCached(query) {
  const entry = readCache()[query]
  if (!entry) return null
  if (Date.now() - entry.t > CACHE_TTL_MS) return null
  return entry.r
}

function setCached(query, results) {
  const cache = readCache()
  cache[query] = { t: Date.now(), r: results }
  writeCache(cache)
}

async function searchCities(query, signal) {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const cached = getCached(q)
  if (cached) return cached

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(q)}` +
    `&format=json&polygon_geojson=1&limit=8&addressdetails=0`

  const res = await fetch(url, {
    signal,
    headers: { 'Accept-Language': 'en' },
  })
  if (!res.ok) throw new Error(`Nominatim search failed: ${res.status}`)

  const json = await res.json()
  const filtered = json
    .filter(
      (r) =>
        r.geojson &&
        (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon'),
    )
    .map((r) => ({
      id: `${r.osm_type}-${r.osm_id}`,
      name: r.display_name,
      shortName: r.display_name.split(',')[0],
      polygon: r.geojson,
      bounds: [
        [parseFloat(r.boundingbox[0]), parseFloat(r.boundingbox[2])],
        [parseFloat(r.boundingbox[1]), parseFloat(r.boundingbox[3])],
      ],
    }))

  setCached(q, filtered)
  return filtered
}

export default function CityPicker({ value, onSelect, onClear }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  const abortRef = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const timer = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      searchCities(query, ctrl.signal)
        .then((r) => {
          setResults(r)
          setError(null)
        })
        .catch((err) => {
          if (err.name === 'AbortError') return
          setResults([])
          setError(err.message || 'Search failed')
        })
        .finally(() => setLoading(false))
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [query])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shrink-0" />
          <span className="text-sentinel-text text-[13px] truncate">{value.shortName}</span>
        </div>
        <button
          onClick={onClear}
          className="text-sentinel-textMuted hover:text-sentinel-text text-[11px] shrink-0 transition-colors"
        >
          Clear
        </button>
      </div>
    )
  }

  const showDropdown = open && (loading || results.length > 0 || error || query.trim().length >= 2)

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search city (e.g. Berlin)"
        className="w-full bg-white/[0.02] border border-white/[0.05] rounded-md px-3 py-2 text-[13px] text-sentinel-text placeholder:text-sentinel-textMuted focus:outline-none focus:border-white/[0.12] transition-colors"
      />
      {showDropdown && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white/[0.02] border border-white/[0.05] rounded-md shadow-lg shadow-black/50">
          {loading && (
            <div className="px-3 py-2 text-[12px] text-sentinel-textMuted">Searching…</div>
          )}
          {!loading && error && (
            <div className="px-3 py-2 text-[12px] text-red-400">{error}</div>
          )}
          {!loading && !error && results.length === 0 && query.trim().length >= 2 && (
            <div className="px-3 py-2 text-[12px] text-sentinel-textMuted">No cities found</div>
          )}
          {!loading && !error &&
            results.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  onSelect(r)
                  setQuery('')
                  setResults([])
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-2 text-[12px] text-sentinel-text hover:bg-white/[0.06] transition-colors truncate"
                title={r.name}
              >
                {r.name}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
