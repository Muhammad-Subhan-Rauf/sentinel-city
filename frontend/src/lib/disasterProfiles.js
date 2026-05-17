// Central registry for disaster-type behavior. Consumed by:
//  - the citizen simulation (perceptionRadius, citizenResponse, affectChance)
//  - routing (blockingRadius decides what feeds Valhalla avoid_polygons)
//  - the UI (geometry kind, icon, color, severity scale, labels)
//
// Phase 2 ships with the full profile shape but a placeholder severity range
// (still 1–10) so the sim has something usable. Phase 3 fills in per-type
// severity scales.

export const DISASTER_PROFILES = {
  Flood: {
    label: 'Flood',
    icon: '🌊',
    color: '#3b82f6',
    geometry: 'area',
    reportingMode: 'observation',
    perceptionRadius: { visual: 200, audible: 0 },
    citizenResponse: 'flee',
    blockingRadius: 'use_drawn_geometry',
    // Flood spreads from the polygon centroid outward at a per-second rate.
    // Citizens flee at 7 m/s, so:
    //   sev 1 → 5 m/s wave: citizens outpace, most escape
    //   sev 3 → 11 m/s wave: middle citizens caught, edges escape
    //   sev 5 → 17 m/s wave: most are caught
    spreads: true,
    spreadRateMps: (sev) => 2 + sev * 3,
    // When a citizen is caught by the wave, this fraction drown (collapse,
    // witnesses report); the rest become "affected" (struggling, self-report).
    faintChance: (sev) => 0.2 + sev * 0.1,
    severity: {
      min: 1,
      max: 5,
      labels: ['Hydrant burst', 'Street flooding', 'Block flooded', 'Neighborhood flooding', 'Major flood event'],
    },
  },
  Wildfire: {
    label: 'Wildfire',
    icon: '🔥',
    color: '#ef4444',
    geometry: 'area',
    reportingMode: 'observation',
    perceptionRadius: { visual: 400, audible: 100 },
    citizenResponse: 'flee',
    blockingRadius: 'use_drawn_geometry',
    // Wildfire spreads slower than floods at low severity, faster at high.
    //   sev 1 → 4 m/s (citizens at 7 m/s outpace), sev 5 → 16 m/s (most caught)
    spreads: true,
    spreadRateMps: (sev) => 1 + sev * 3,
    faintChance: (sev) => 0.15 + sev * 0.1,
    severity: {
      min: 1,
      max: 5,
      labels: ['Brush fire', 'Building fire', 'Multi-building', 'Block-wide', 'Conflagration'],
    },
  },
  Heatwave: {
    label: 'Heatwave',
    icon: '☀️',
    color: '#fbbf24',
    geometry: 'city',
    reportingMode: 'affected',
    perceptionRadius: { visual: 0, audible: 0 },
    citizenResponse: 'shelter',
    blockingRadius: 0,
    // Per-citizen per-tick chance of feeling unwell enough to call 911.
    // Citywide at sev 4 with 1500 citizens: ~0.075/sec → ~4-5 calls/min.
    affectChance: (sev) => 0.000008 * sev,
    // Conditional on the affect roll passing: chance the citizen *faints*
    // instead of just feeling unwell. Fainted citizens stop moving and can
    // only be reported by passing witnesses.
    faintChance: (sev) => 0.04 * sev,
    symptomLabel: 'Heat exhaustion — caller reported feeling faint and disoriented.',
    severity: {
      min: 1,
      max: 4,
      labels: ['Warm advisory', 'Hot day', 'Severe heat', 'Extreme heatwave'],
    },
  },
  Power_Outage: {
    label: 'Power Outage',
    icon: '⚡',
    color: '#14b8a6',
    geometry: 'city',                       // default geometry mode
    allowedGeometries: ['city', 'area'],    // operator can switch to a specific area
    reportingMode: 'affected',
    perceptionRadius: { visual: 0, audible: 0 },
    citizenResponse: 'neutral',
    blockingRadius: 0,
    // ~0.001/sev/tick → at sev 3, ~3 calls per 1000 affected citizens per tick.
    // Tuned so an area-mode outage covering a few blocks produces a steady
    // trickle of calls; a citywide grid failure produces a flood.
    affectChance: (sev) => 0.001 * sev,
    symptomLabel: 'Power outage — caller stuck in elevator or otherwise distressed.',
    severity: {
      min: 1,
      max: 3,
      labels: ['Localized', 'Borough-wide', 'Grid failure'],
    },
  },
  Robbery: {
    label: 'Robbery',
    icon: '💰',
    color: '#f59e0b',
    geometry: 'point',
    reportingMode: 'observation',
    perceptionRadius: { visual: 80, audible: (sev) => (sev >= 2 ? 250 : 0) },
    citizenResponse: 'flee',
    blockingRadius: (sev) => (sev >= 3 ? 50 : 0),
    severity: {
      min: 1,
      max: 4,
      labels: ['Pickpocket', 'Armed individual', 'Heavy weapons', 'Armed group'],
    },
  },
  Gang_Violence: {
    label: 'Gang Violence',
    icon: '⚔️',
    color: '#ec4899',
    geometry: 'point',
    reportingMode: 'observation',
    perceptionRadius: { visual: 80, audible: 400 },
    citizenResponse: 'hide',
    blockingRadius: (sev) => 50 + sev * 30,
    severity: {
      min: 1,
      max: 5,
      labels: ['Brawl', 'Single shooter', 'Multiple shooters', 'Heavy exchange', 'Mass shooting'],
    },
  },
  Accident: {
    label: 'Accident',
    icon: '💥',
    color: '#fb923c',
    geometry: 'point',
    reportingMode: 'observation',
    perceptionRadius: { visual: 100, audible: 150 },
    citizenResponse: 'approach',
    blockingRadius: (sev) => 30 + sev * 20,
    severity: {
      min: 1,
      max: 4,
      labels: ['Minor collision', 'Injury accident', 'Multi-vehicle', 'Major casualty'],
    },
  },
  Road_Blockage: {
    label: 'Road Blockage',
    icon: '🚧',
    color: '#f97316',
    geometry: 'point',
    reportingMode: 'observation',
    perceptionRadius: { visual: 80, audible: 0 },
    citizenResponse: 'neutral',
    blockingRadius: () => 80,
    severity: {
      min: 1,
      max: 3,
      labels: ['Lane closure', 'Full road', 'Intersection blocked'],
    },
  },
  Infrastructure_Failure: {
    label: 'Infrastructure Failure',
    icon: '🏗️',
    color: '#a78bfa',
    geometry: 'point',
    reportingMode: 'observation',
    perceptionRadius: { visual: 150, audible: 100 },
    citizenResponse: 'flee',
    blockingRadius: (sev) => 50 + sev * 25,
    severity: {
      min: 1,
      max: 4,
      labels: ['Water main', 'Gas leak', 'Partial collapse', 'Building collapse'],
    },
  },
}

// Returns 'point' | 'area' | 'city' — the default geometry mode for a type.
export function getGeometryMode(type) {
  return DISASTER_PROFILES[type]?.geometry || 'area'
}

// Returns the array of geometry modes the operator can choose between for a type.
// Types with a fixed geometry return a single-element array.
export function getAllowedGeometries(type) {
  const p = DISASTER_PROFILES[type]
  if (!p) return ['area']
  return p.allowedGeometries || [p.geometry || 'area']
}

export function getProfile(type) {
  return DISASTER_PROFILES[type] || null
}

// Resolve a perception radius that might be a constant or a severity-dependent function.
function resolveRadius(spec, severity) {
  if (typeof spec === 'function') return spec(severity) || 0
  return Number(spec) || 0
}

export function getPerception(type, severity) {
  const p = DISASTER_PROFILES[type]
  if (!p) return { visual: 0, audible: 0 }
  return {
    visual: resolveRadius(p.perceptionRadius?.visual, severity),
    audible: resolveRadius(p.perceptionRadius?.audible, severity),
  }
}

// Returns:
//   number → buffer the point by N meters to form an avoid polygon
//   'use_drawn_geometry' → the operator's polygon/circle is itself the block
//   0 → do not feed Valhalla avoid_polygons
export function getBlockingRadius(type, severity) {
  const p = DISASTER_PROFILES[type]
  if (!p) return 0
  const b = p.blockingRadius
  if (b === 'use_drawn_geometry') return 'use_drawn_geometry'
  if (typeof b === 'function') return b(severity) || 0
  return Number(b) || 0
}

export function severityLabel(type, severity) {
  const p = DISASTER_PROFILES[type]
  if (!p || !p.severity?.labels?.length) return ''
  const idx = severity - p.severity.min
  return p.severity.labels[idx] || ''
}

export function normalizeSeverity(type, severity) {
  const p = DISASTER_PROFILES[type]
  if (!p) return 0.5
  const { min, max } = p.severity
  if (max === min) return 1
  return Math.max(0, Math.min(1, (severity - min) / (max - min)))
}

// Severity color stays a function of the normalized value, so a sev-4 robbery and
// a sev-5 flood (both ~80% of their respective scales) read at similar intensity.
export function severityColor(type, severity) {
  const n = normalizeSeverity(type, severity)
  if (n <= 0.3) return '#10b981'   // emerald
  if (n <= 0.5) return '#eab308'   // yellow
  if (n <= 0.7) return '#f97316'   // orange
  if (n <= 0.9) return '#ef4444'   // red
  return '#dc2626'                 // dark red
}

// Convenience derivation for the old DISASTER_TYPES iteration sites.
export const DISASTER_TYPES = Object.entries(DISASTER_PROFILES).map(([value, p]) => ({
  value,
  label: p.label,
  icon: p.icon,
  color: p.color,
}))
