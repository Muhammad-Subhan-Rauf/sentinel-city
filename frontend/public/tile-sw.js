// Sentinel-City tile cache service worker.
// Intercepts basemap raster requests (CARTO dark/voyager, ArcGIS satellite)
// and serves them from a Cache API store. First visit fetches normally and
// populates the cache; every subsequent pan / zoom / page reload that hits a
// previously-seen tile resolves instantly without a network round trip.

const CACHE_NAME = 'sentinel-tiles-v1'
const MAX_ENTRIES = 4000 // ~roughly 200 MB worst case at 50 KB/tile

const TILE_HOST_RE = /^https:\/\/(?:[a-d]\.basemaps\.cartocdn\.com|server\.arcgisonline\.com)\//

self.addEventListener('install', () => {
  // Take over from any previous version immediately.
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

// Best-effort FIFO eviction once the cache crosses MAX_ENTRIES. Not exact LRU
// but cheap, and we only run it occasionally.
async function trimCache(cache) {
  const requests = await cache.keys()
  const excess = requests.length - MAX_ENTRIES
  if (excess <= 0) return
  await Promise.all(requests.slice(0, excess).map((r) => cache.delete(r)))
}

self.addEventListener('fetch', (e) => {
  const url = e.request.url
  if (e.request.method !== 'GET') return
  if (!TILE_HOST_RE.test(url)) return

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(e.request)
      if (hit) return hit
      try {
        const res = await fetch(e.request)
        if (res && res.ok) {
          // Clone before reading the body for the cache write.
          cache.put(e.request, res.clone()).then(() => {
            // Occasional eviction — every ~100 inserts on average.
            if (Math.random() < 0.01) trimCache(cache)
          })
        }
        return res
      } catch (err) {
        // Offline + cache miss → return a 1×1 transparent PNG so the map
        // doesn't show a broken-image icon. Leaflet treats this as a loaded tile.
        return new Response(
          Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0)),
          { status: 200, headers: { 'Content-Type': 'image/png' } },
        )
      }
    })(),
  )
})
