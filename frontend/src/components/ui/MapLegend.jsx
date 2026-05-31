import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * MapLegend — collapsible glass panel that explains every map symbol.
 *
 * Default-collapsed (only a small toggle button visible). Expanded form
 * shows category sections with a swatch + label per entry.
 *
 * Built as a static reference panel — the visual examples are stylized
 * versions of what appears on the map, intentionally simplified.
 *
 * The categories cover what's actually rendered by MapView. If new symbols
 * are added to MapView, add them here too.
 */

const SECTIONS = [
  {
    title: 'Citizens',
    items: [
      { swatch: <Ring color="#22d3ee" />, label: 'Mobile citizen' },
      { swatch: <Ring color="#f97316" pulse />, label: 'Affected (reporting)' },
      { swatch: <Ring color="#ef4444" />, label: 'In danger / trapped' },
      { swatch: <Ring color="#22c55e" />, label: 'Recovered / safe' },
    ],
  },
  {
    title: 'Responders',
    items: [
      { swatch: <Ring color="#ec4899" />, label: 'Worker (idle)' },
      { swatch: <Ring color="#f59e0b" />, label: 'Worker (dispatched)' },
      { swatch: <Ring color="#ef4444" />, label: 'Worker (on scene)' },
      { swatch: <Square color="#22d3ee" />, label: 'Station / hospital / police' },
    ],
  },
  {
    title: 'Incidents',
    items: [
      { swatch: <Polygon color="#ef4444" />, label: 'Active disaster zone' },
      { swatch: <Polygon color="#71717a" />, label: 'Resolved zone' },
      { swatch: <DashedPolygon color="#f97316" />, label: 'Notification area' },
      { swatch: <DashedPolygon color="#ef4444" />, label: 'Cordoned area' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { swatch: <Line color="#22d3ee" />, label: 'Route / path' },
      { swatch: <PulseRing color="#f97316" />, label: 'Active dispatch radius' },
      { swatch: <Dot color="#22d3ee" />, label: 'Mock CCTV camera' },
      { swatch: <Dot color="#0ea5b7" small />, label: 'Road intersection' },
    ],
  },
  {
    title: 'Weather',
    items: [
      { swatch: <Polygon color="#3b82f6" opacity={0.3} />, label: 'Storm / rain region' },
      { swatch: <Polygon color="#f59e0b" opacity={0.3} />, label: 'Heat / drought region' },
    ],
  },
]

export default function MapLegend({ open: controlledOpen, onOpenChange, defaultOpen = false }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = (next) => {
    const value = typeof next === 'function' ? next(open) : next
    if (isControlled) onOpenChange?.(value)
    else setUncontrolledOpen(value)
  }

  return (
    <div className="absolute bottom-4 right-[8.5rem] z-30 select-none">
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="legend-panel"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="glass-strong rounded-2xl mb-2 p-3 w-[260px] max-h-[60vh] overflow-y-auto"
            role="region"
            aria-label="Map legend"
            style={{ transformOrigin: 'bottom right' }}
          >
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/[0.05]">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sentinel-info">
                Map Legend
              </h3>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close legend"
                className="text-sentinel-textMuted hover:text-sentinel-text w-5 h-5 flex items-center justify-center rounded hover:bg-white/[0.05] transition-colors text-[14px] leading-none"
              >
                ×
              </button>
            </div>
            <div className="space-y-3">
              {SECTIONS.map((section) => (
                <section key={section.title}>
                  <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-sentinel-textMuted mb-1.5">
                    {section.title}
                  </div>
                  <ul className="space-y-1.5">
                    {section.items.map((it, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2.5 text-[11px] text-sentinel-textDim"
                      >
                        <span className="w-5 h-5 flex items-center justify-center shrink-0">
                          {it.swatch}
                        </span>
                        <span className="leading-snug">{it.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Close map legend' : 'Open map legend'}
        title={open ? 'Hide legend' : 'Show legend'}
        className={[
          'glass inline-flex items-center justify-center w-9 h-9 rounded-lg transition-all ml-auto',
          open
            ? 'text-sentinel-info border-sentinel-info/40 shadow-glow'
            : 'text-sentinel-textDim hover:text-sentinel-info hover:border-sentinel-info/30 hover:shadow-glow',
        ].join(' ')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>
    </div>
  )
}

/* ─── Swatch primitives ─────────────────────────────────────── */

function Ring({ color, pulse = false }) {
  return (
    <span className="relative inline-flex items-center justify-center w-4 h-4">
      {pulse && (
        <span
          className="absolute inset-0 rounded-full animate-ping opacity-60"
          style={{ background: color }}
        />
      )}
      <span
        className="relative inline-block w-2.5 h-2.5 rounded-full border-2"
        style={{ borderColor: color, background: `${color}22` }}
      />
    </span>
  )
}

function Dot({ color, small = false }) {
  return (
    <span
      className={`inline-block rounded-full ${small ? 'w-1.5 h-1.5' : 'w-2.5 h-2.5'}`}
      style={{ background: color, boxShadow: `0 0 6px ${color}aa` }}
    />
  )
}

function Square({ color }) {
  return (
    <span
      className="inline-block w-3 h-3 rounded-[3px]"
      style={{
        background: `${color}33`,
        border: `1.5px solid ${color}`,
      }}
    />
  )
}

function Polygon({ color, opacity = 0.5 }) {
  return (
    <span
      className="inline-block w-4 h-3 rounded-[2px]"
      style={{
        background: `${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`,
        border: `1px solid ${color}`,
      }}
    />
  )
}

function DashedPolygon({ color }) {
  return (
    <span
      className="inline-block w-4 h-3 rounded-[2px]"
      style={{
        background: `${color}22`,
        border: `1.5px dashed ${color}`,
      }}
    />
  )
}

function Line({ color }) {
  return (
    <span
      className="inline-block w-4 h-1 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}aa` }}
    />
  )
}

function PulseRing({ color }) {
  return (
    <span className="relative inline-flex items-center justify-center w-4 h-4">
      <span
        className="absolute inset-0 rounded-full animate-ping opacity-50"
        style={{ background: color }}
      />
      <span
        className="relative inline-block w-3 h-3 rounded-full border-[1.5px]"
        style={{ borderColor: color }}
      />
    </span>
  )
}
