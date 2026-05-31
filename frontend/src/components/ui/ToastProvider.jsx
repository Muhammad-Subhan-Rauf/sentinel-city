import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

/**
 * Toast system — small queue of notifications that pop top-right and
 * auto-dismiss. Designed for operator-grade signals: new high-sev calls,
 * incident state changes, backend errors.
 *
 * Usage:
 *   const toast = useToast()
 *   toast.warn('High-severity call', '#42 from citizen at lat,lng')
 *   toast.info('Zone activated', 'Wildfire severity 7')
 *   toast.danger('Backend offline')
 *
 * API surface intentionally narrow — no rich content, no actions yet.
 * Add an `action: { label, onClick }` prop later when a real use case shows up.
 *
 * Provider also exposes `clear()` for bulk dismiss (used by /clear in command
 * palette or Esc when no other overlay is on top — caller's choice).
 */

const ToastContext = createContext(null)

const MAX_VISIBLE = 4
const DEFAULT_DURATION = 5000

let nextId = 1

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const enqueue = useCallback(
    (variant, title, description, opts = {}) => {
      const id = nextId++
      const duration = opts.duration ?? DEFAULT_DURATION
      setToasts((prev) => {
        // Cap the queue — drop oldest when over limit.
        const next = [...prev, { id, variant, title, description, createdAt: Date.now() }]
        return next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next
      })
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration)
        timersRef.current.set(id, timer)
      }
      return id
    },
    [dismiss],
  )

  const clear = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current.clear()
    setToasts([])
  }, [])

  useEffect(() => () => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current.clear()
  }, [])

  const api = {
    info: (title, description, opts) => enqueue('info', title, description, opts),
    success: (title, description, opts) => enqueue('success', title, description, opts),
    warn: (title, description, opts) => enqueue('warn', title, description, opts),
    danger: (title, description, opts) => enqueue('danger', title, description, opts),
    dismiss,
    clear,
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>')
  return ctx
}

/* ─── Renderer ──────────────────────────────────────────────── */

const VARIANT = {
  info: {
    bar: 'bg-sentinel-info',
    text: 'text-sentinel-info',
    border: 'border-sentinel-info/30',
    glow: 'shadow-glow',
    icon: InfoIcon,
  },
  success: {
    bar: 'bg-sentinel-safe',
    text: 'text-sentinel-safe',
    border: 'border-sentinel-safe/30',
    glow: 'shadow-[0_0_24px_rgba(34,197,94,0.28)]',
    icon: CheckIcon,
  },
  warn: {
    bar: 'bg-sentinel-warn',
    text: 'text-sentinel-warn',
    border: 'border-sentinel-warn/30',
    glow: 'shadow-[0_0_24px_rgba(245,158,11,0.28)]',
    icon: WarnIcon,
  },
  danger: {
    bar: 'bg-sentinel-danger',
    text: 'text-sentinel-danger',
    border: 'border-sentinel-danger/40',
    glow: 'shadow-glow-danger',
    icon: DangerIcon,
  },
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      className="fixed top-4 right-4 z-[1200] flex flex-col gap-2 pointer-events-none w-[340px] max-w-[calc(100vw-2rem)]"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastItem({ toast, onDismiss }) {
  const reduce = useReducedMotion()
  const v = VARIANT[toast.variant] ?? VARIANT.info
  const Icon = v.icon

  return (
    <motion.div
      layout={!reduce}
      initial={{ opacity: 0, x: 32, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 32, scale: 0.96 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      className={`pointer-events-auto glass-strong rounded-xl overflow-hidden ${v.border} ${v.glow}`}
      role="status"
    >
      <div className="flex gap-3 p-3">
        <span className={`mt-0.5 shrink-0 ${v.text}`} aria-hidden="true">
          <Icon />
        </span>
        <div className="flex-1 min-w-0">
          <div className={`text-[12px] font-semibold leading-snug ${v.text}`}>
            {toast.title}
          </div>
          {toast.description && (
            <div className="text-[11px] text-sentinel-textDim leading-snug mt-0.5 break-words">
              {toast.description}
            </div>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="shrink-0 -m-1 p-1 text-sentinel-textMuted hover:text-sentinel-text transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <span
        className={`block h-[2px] ${v.bar}`}
        aria-hidden="true"
        style={{ opacity: 0.6 }}
      />
    </motion.div>
  )
}

/* ─── Icons (Lucide-style, 16px) ─────────────────────────────── */

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function WarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}
function DangerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}
