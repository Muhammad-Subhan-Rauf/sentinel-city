import { useEffect, useState } from 'react'

/**
 * StatusStrip — top-of-sidebar one-glance situational awareness bar.
 *
 * Shows:
 *   - Live wall-clock (updates every second)
 *   - Backend connection state (probed via the BACKEND_URL prop or simStatus)
 *   - Active incident count
 *   - Active responder count (optional)
 *
 * Designed to be thin (~32px tall) and mono — operator-grade telemetry strip.
 */
export default function StatusStrip({
  online = true,
  activeIncidents = 0,
  activeResponders = null,
  simReady = false,
}) {
  const [time, setTime] = useState(() => formatTime(new Date()))

  useEffect(() => {
    const id = setInterval(() => setTime(formatTime(new Date())), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      role="status"
      aria-label="System status"
      className="flex items-center gap-3 px-5 py-1.5 border-b border-white/[0.05] font-mono text-[10px] text-sentinel-textDim tabular"
    >
      <span className="text-sentinel-text font-medium" aria-label="Current time">
        {time}
      </span>

      <span className="w-px h-3 bg-white/[0.08]" aria-hidden="true" />

      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          {online && (
            <span className="absolute inset-0 rounded-full bg-sentinel-safe animate-ping opacity-50" />
          )}
          <span
            className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
              online ? 'bg-sentinel-safe' : 'bg-sentinel-danger'
            }`}
          />
        </span>
        <span className="uppercase tracking-wider">
          {online ? 'NET' : 'OFFLINE'}
        </span>
      </span>

      <span className="w-px h-3 bg-white/[0.08]" aria-hidden="true" />

      <span className="inline-flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            simReady ? 'bg-sentinel-info' : 'bg-sentinel-warn animate-pulse'
          }`}
          aria-hidden="true"
        />
        <span className="uppercase tracking-wider">
          {simReady ? 'SIM' : 'BOOT'}
        </span>
      </span>

      <span className="flex-1" />

      {activeIncidents > 0 && (
        <span className="inline-flex items-center gap-1 text-sentinel-accent">
          <span className="uppercase tracking-wider">INC</span>
          <span className="text-sentinel-text font-medium">{activeIncidents}</span>
        </span>
      )}
      {activeResponders != null && activeResponders > 0 && (
        <span className="inline-flex items-center gap-1 text-sentinel-info">
          <span className="uppercase tracking-wider">RESP</span>
          <span className="text-sentinel-text font-medium">{activeResponders}</span>
        </span>
      )}
    </div>
  )
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
