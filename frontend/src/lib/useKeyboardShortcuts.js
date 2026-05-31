import { useEffect } from 'react'

/**
 * useKeyboardShortcuts — binds keyboard handlers to window.
 *
 * Skips shortcuts when the user is typing in <input>, <textarea>, or
 * contentEditable so common letters don't trigger global actions.
 *
 * Usage:
 *   useKeyboardShortcuts({
 *     '?':       () => setHelpOpen((v) => !v),
 *     'c':       () => setCallsOpen((v) => !v),
 *     'Escape':  () => closeAny(),
 *     'cmd+k':   () => setPaletteOpen(true),
 *     '1':       () => pickDisaster(0),
 *   })
 *
 * Key matching:
 *   - Plain letter/symbol keys match the rendered character (case-insensitive
 *     for letters; '?' matches Shift+/ on US layout — checked via event.key).
 *   - Use 'cmd+k' / 'ctrl+k' for chord modifiers (uses platform-aware match:
 *     "cmd" maps to metaKey on macOS, ctrlKey on Win/Linux).
 *   - Use 'shift+l' / 'alt+f' similarly.
 *   - Reserved special names: 'Escape', 'Enter', 'ArrowUp', 'ArrowDown',
 *     'ArrowLeft', 'ArrowRight', 'Tab'.
 *
 * Handlers receive the KeyboardEvent and can call e.preventDefault().
 */
export default function useKeyboardShortcuts(map, { enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')

    const handler = (e) => {
      const t = e.target
      // Don't intercept while user is typing in a form field.
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        // Allow Esc + Cmd+K even while typing — they're universally expected.
        const allowWhileTyping =
          e.key === 'Escape' ||
          ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')
        if (!allowWhileTyping) return
      }

      for (const [combo, fn] of Object.entries(map)) {
        if (!fn) continue
        if (matchCombo(combo, e, isMac)) {
          fn(e)
          return
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [map, enabled])
}

function matchCombo(combo, e, isMac) {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim())
  const want = parts[parts.length - 1]
  const wantCmd = parts.includes('cmd')
  const wantCtrl = parts.includes('ctrl')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')

  const eventKey = e.key
  const eventKeyLower = eventKey.length === 1 ? eventKey.toLowerCase() : eventKey

  // Match the final key
  if (eventKeyLower !== want.toLowerCase()) return false

  // Modifier matching: 'cmd' resolves to metaKey on Mac, ctrlKey otherwise.
  const expectMeta = (wantCmd && isMac) || (wantCtrl && !isMac && !wantCmd)
  const expectCtrl = (wantCtrl && isMac) || (wantCmd && !isMac) || (wantCtrl && !isMac)

  // For simple keys (no cmd/ctrl), reject if any modifier is pressed unless
  // explicitly part of the combo (e.g. plain 'c' shouldn't fire on Cmd+C).
  if (!wantCmd && !wantCtrl) {
    if (e.metaKey || e.ctrlKey) return false
  } else {
    if (!!e.metaKey !== !!expectMeta) return false
    if (!!e.ctrlKey !== !!expectCtrl) return false
  }
  if (wantShift !== e.shiftKey) return false
  if (wantAlt !== e.altKey) return false

  return true
}
