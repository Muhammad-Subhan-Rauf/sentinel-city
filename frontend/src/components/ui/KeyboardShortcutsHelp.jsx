import { AnimatePresence, motion } from 'framer-motion'

/**
 * KeyboardShortcutsHelp — glass modal listing every shortcut.
 *
 * Triggered by `?`. Dismiss via Esc or click outside or × button.
 * Renders as a centered overlay above the dashboard with a dark backdrop.
 *
 * The shortcut map is hardcoded here to match the bindings registered in
 * DisasterDashboard via useKeyboardShortcuts. Keep in sync.
 */

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')
const MOD = isMac ? '⌘' : 'Ctrl'

const SHORTCUTS = [
  {
    group: 'Navigation',
    items: [
      { keys: [MOD, 'K'], label: 'Open command palette' },
      { keys: ['?'], label: 'Toggle this help overlay' },
      { keys: ['Esc'], label: 'Close drawer / dialog / palette' },
    ],
  },
  {
    group: 'Drawers',
    items: [
      { keys: ['C'], label: 'Toggle 911 calls drawer' },
      { keys: ['A'], label: 'Toggle AI logs drawer' },
      { keys: ['L'], label: 'Toggle map legend' },
    ],
  },
  {
    group: 'Workspace',
    items: [
      { keys: ['F'], label: 'Toggle focus mode (hide sidebar)' },
      { keys: ['1', '–', '9'], label: 'Quick-pick disaster type' },
    ],
  },
]

export default function KeyboardShortcutsHelp({ open, onClose }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[1100] bg-black/50 backdrop-blur-xs"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            role="dialog"
            aria-labelledby="kbd-help-title"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1110] glass-strong rounded-2xl w-[480px] max-w-[90vw] max-h-[80vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05]">
              <h2
                id="kbd-help-title"
                className="text-[12px] font-semibold uppercase tracking-[0.12em] text-sentinel-info"
              >
                Keyboard Shortcuts
              </h2>
              <button
                onClick={onClose}
                aria-label="Close shortcuts help"
                className="text-sentinel-textMuted hover:text-sentinel-text w-6 h-6 flex items-center justify-center rounded hover:bg-white/[0.05] transition-colors text-[16px] leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-5 space-y-5">
              {SHORTCUTS.map((g) => (
                <section key={g.group}>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sentinel-textMuted mb-2.5">
                    {g.group}
                  </div>
                  <ul className="space-y-1.5">
                    {g.items.map((it, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-white/[0.03] transition-colors"
                      >
                        <span className="text-[13px] text-sentinel-text">
                          {it.label}
                        </span>
                        <span className="flex items-center gap-1">
                          {it.keys.map((k, j) =>
                            k === '–' ? (
                              <span key={j} className="text-sentinel-textMuted text-[11px] px-0.5">
                                {k}
                              </span>
                            ) : (
                              <kbd
                                key={j}
                                className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-md font-mono text-[11px] text-sentinel-text bg-white/[0.05] border border-white/[0.1] shadow-[inset_0_-1px_0_rgba(0,0,0,0.3)]"
                              >
                                {k}
                              </kbd>
                            )
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            <div className="px-5 py-3 border-t border-white/[0.05] text-[11px] text-sentinel-textMuted">
              Press <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded font-mono text-[10px] bg-white/[0.05] border border-white/[0.08]">?</kbd> anytime to open this help.
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
