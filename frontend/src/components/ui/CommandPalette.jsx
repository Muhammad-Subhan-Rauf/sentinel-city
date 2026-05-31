import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * CommandPalette — Cmd+K / Ctrl+K fuzzy launcher.
 *
 * Single-purpose: take a flat list of commands from the parent (with id, title,
 * group, onSelect, optional description / shortcut / keywords) and render a
 * searchable list. Keyboard-first: arrow up/down to move, Enter to execute,
 * Esc to close. Click also works.
 *
 * Filter is a lightweight per-character substring score against title +
 * description + keywords. Not a true fuzzy ranker; good enough for ≤200 items.
 *
 * Empty query → show all commands grouped by `group`.
 * Non-empty query → show flat ranked list, top match auto-highlighted.
 */

export default function CommandPalette({ open, onClose, commands = [], placeholder = 'Search commands…' }) {
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const results = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase().trim()
    return commands
      .map((c) => ({ ...c, _score: scoreCommand(c, q) }))
      .filter((c) => c._score > 0)
      .sort((a, b) => b._score - a._score)
  }, [commands, query])

  // Group items only when no query (search mode is flat).
  const grouped = useMemo(() => {
    if (query.trim()) return null
    const groups = new Map()
    for (const r of results) {
      const key = r.group ?? 'Other'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    }
    return [...groups.entries()]
  }, [results, query])

  // Reset state when opening + focus input.
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlightIdx(0)
      // next tick for focus after the modal mounts
      const id = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(id)
    }
  }, [open])

  // Clamp highlight as results change.
  useEffect(() => {
    if (highlightIdx >= results.length) {
      setHighlightIdx(Math.max(0, results.length - 1))
    }
  }, [results.length, highlightIdx])

  // Scroll the highlighted item into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${highlightIdx}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightIdx])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = results[highlightIdx]
      if (cmd) {
        cmd.onSelect?.()
        onClose?.()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose?.()
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[1300] bg-black/50 backdrop-blur-xs"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            role="dialog"
            aria-label="Command palette"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="fixed left-1/2 top-[18%] -translate-x-1/2 z-[1310] glass-strong rounded-2xl w-[560px] max-w-[90vw] overflow-hidden flex flex-col max-h-[60vh]"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sentinel-info shrink-0" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setHighlightIdx(0)
                }}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                className="flex-1 bg-transparent text-[14px] text-sentinel-text placeholder:text-sentinel-textMuted outline-none"
                aria-label="Search commands"
                spellCheck={false}
                autoComplete="off"
              />
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-sentinel-textDim">
                Esc
              </kbd>
            </div>

            <div ref={listRef} className="overflow-y-auto px-2 py-2">
              {results.length === 0 ? (
                <div className="text-center text-[12px] text-sentinel-textMuted py-8">
                  No commands match
                  <span className="text-sentinel-textDim"> "{query}"</span>
                </div>
              ) : grouped ? (
                grouped.map(([group, items]) => (
                  <div key={group} className="mb-2">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-sentinel-textMuted px-2 py-1.5">
                      {group}
                    </div>
                    <ul>
                      {items.map((cmd) => {
                        const flatIdx = results.indexOf(cmd)
                        return (
                          <CommandRow
                            key={cmd.id}
                            cmd={cmd}
                            idx={flatIdx}
                            highlighted={flatIdx === highlightIdx}
                            onHover={() => setHighlightIdx(flatIdx)}
                            onSelect={() => {
                              cmd.onSelect?.()
                              onClose?.()
                            }}
                          />
                        )
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <ul>
                  {results.map((cmd, i) => (
                    <CommandRow
                      key={cmd.id}
                      cmd={cmd}
                      idx={i}
                      highlighted={i === highlightIdx}
                      onHover={() => setHighlightIdx(i)}
                      onSelect={() => {
                        cmd.onSelect?.()
                        onClose?.()
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-white/[0.05] text-[10px] text-sentinel-textMuted">
              <span className="inline-flex items-center gap-2">
                <Hint k="↑↓" label="Navigate" />
                <Hint k="↵" label="Select" />
                <Hint k="Esc" label="Close" />
              </span>
              <span className="tabular">
                {results.length} {results.length === 1 ? 'command' : 'commands'}
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function CommandRow({ cmd, idx, highlighted, onHover, onSelect }) {
  return (
    <li
      data-idx={idx}
      onMouseEnter={onHover}
      onClick={onSelect}
      role="option"
      aria-selected={highlighted}
      className={[
        'flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer transition-colors',
        highlighted ? 'bg-sentinel-info/15' : 'hover:bg-white/[0.03]',
      ].join(' ')}
    >
      <span
        className={[
          'shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[14px]',
          highlighted
            ? 'bg-sentinel-info/20 text-sentinel-info'
            : 'bg-white/[0.04] text-sentinel-textDim',
        ].join(' ')}
        aria-hidden="true"
      >
        {cmd.icon ?? <DefaultIcon />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-sentinel-text leading-snug truncate">
          {cmd.title}
        </div>
        {cmd.description && (
          <div className="text-[11px] text-sentinel-textMuted leading-snug truncate">
            {cmd.description}
          </div>
        )}
      </div>
      {cmd.shortcut && (
        <span className="flex items-center gap-1 shrink-0">
          {cmd.shortcut.map((k, i) => (
            <kbd
              key={i}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-sentinel-textDim"
            >
              {k}
            </kbd>
          ))}
        </span>
      )}
    </li>
  )
}

function Hint({ k, label }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-sentinel-textDim">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  )
}

function DefaultIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

/* ─── Score function ─────────────────────────────────────────── */

function scoreCommand(cmd, q) {
  const haystacks = [
    { text: cmd.title?.toLowerCase() || '', weight: 3 },
    { text: cmd.description?.toLowerCase() || '', weight: 1 },
    { text: (cmd.keywords || []).join(' ').toLowerCase(), weight: 2 },
    { text: cmd.group?.toLowerCase() || '', weight: 1 },
  ]
  let score = 0
  for (const { text, weight } of haystacks) {
    if (!text) continue
    if (text === q) score += 10 * weight
    else if (text.startsWith(q)) score += 6 * weight
    else if (text.includes(q)) score += 3 * weight
  }
  // Bonus for tokens — splitting helps multi-word matches.
  const titleTokens = (cmd.title || '').toLowerCase().split(/\s+/)
  if (titleTokens.some((t) => t.startsWith(q))) score += 2
  return score
}
