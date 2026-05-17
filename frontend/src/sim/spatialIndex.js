// Flat lat/lng grid bucket for O(1)-average proximity queries.
// Cell size ~111m at the equator (lat × 1000 → integer at degree resolution),
// matching the scale at which the citizen sim asks "is anything nearby?".

const SCALE = 1000

export class SpatialIndex {
  constructor() {
    // key: `${latBucket}|${lngBucket}` → Array<item>
    this.buckets = new Map()
  }

  static keyFor(lat, lng) {
    return `${Math.floor(lat * SCALE)}|${Math.floor(lng * SCALE)}`
  }

  clear() {
    this.buckets.clear()
  }

  insert(item, lat, lng) {
    const key = SpatialIndex.keyFor(lat, lng)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = []
      this.buckets.set(key, bucket)
    }
    bucket.push(item)
  }

  // Return everything in the bucket containing (lat,lng) plus its 8 neighbors.
  // Caller is expected to apply a precise distance check.
  near(lat, lng) {
    const cl = Math.floor(lat * SCALE)
    const cln = Math.floor(lng * SCALE)
    const out = []
    for (let dl = -1; dl <= 1; dl++) {
      for (let dln = -1; dln <= 1; dln++) {
        const bucket = this.buckets.get(`${cl + dl}|${cln + dln}`)
        if (bucket) out.push(...bucket)
      }
    }
    return out
  }
}
