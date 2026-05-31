import { motion, useReducedMotion } from 'framer-motion'

/**
 * BentoCell — a single glass surface inside the bento grid.
 *
 * Variants:
 *   default — neutral glass
 *   info    — cyan-tinted (telemetry, AI, weather)
 *   accent  — orange-tinted (active disaster, dispatch)
 *   danger  — red-tinted (active emergency / alerts)
 *
 * Interaction:
 *   - hover lifts by 2px and brightens the border-glow
 *   - mounts with a slight fade+rise via parent BentoStagger
 *   - `interactive={false}` disables hover (use for stage/map containers)
 *
 * Accessibility:
 *   - `aria-label` + `role="region"` for screen-reader navigation
 *   - respects prefers-reduced-motion via useReducedMotion
 */
const VARIANT_CLASS = {
  default: 'glass',
  strong: 'glass-strong',
  info: 'glass glass-info',
  accent: 'glass glass-accent',
  danger: 'glass glass-danger',
}

const VARIANT_TITLE_COLOR = {
  default: 'text-sentinel-textDim',
  strong: 'text-sentinel-textDim',
  info: 'text-sentinel-info',
  accent: 'text-sentinel-accent',
  danger: 'text-sentinel-danger',
}

const cellVariants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
  },
}

export default function BentoCell({
  variant = 'default',
  title,
  icon,
  meta,
  actions,
  children,
  className = '',
  bodyClassName = '',
  interactive = true,
  ariaLabel,
  onClick,
}) {
  const reduceMotion = useReducedMotion()
  const variantClass = VARIANT_CLASS[variant] ?? VARIANT_CLASS.default
  const titleColor = VARIANT_TITLE_COLOR[variant] ?? VARIANT_TITLE_COLOR.default

  const hoverProps =
    interactive && !reduceMotion
      ? { whileHover: { y: -2 }, whileTap: { y: 0 } }
      : {}

  return (
    <motion.section
      variants={cellVariants}
      {...hoverProps}
      onClick={onClick}
      role="region"
      aria-label={ariaLabel ?? title}
      className={`
        relative rounded-2xl overflow-hidden
        ${variantClass}
        ${interactive ? 'transition-shadow duration-200 hover:shadow-glass-hover' : ''}
        ${onClick ? 'cursor-pointer' : ''}
        ${className}
      `}
      style={{ contain: 'layout paint' }}
    >
      {(title || icon || meta || actions) && (
        <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/[0.04]">
          <div className="flex items-center gap-2 min-w-0">
            {icon && (
              <span className={`flex-shrink-0 ${titleColor}`} aria-hidden="true">
                {icon}
              </span>
            )}
            {title && (
              <h2
                className={`text-[11px] font-medium uppercase tracking-[0.12em] ${titleColor} truncate`}
              >
                {title}
              </h2>
            )}
            {meta && (
              <span className="text-[11px] text-sentinel-textMuted tabular truncate">
                {meta}
              </span>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-1 flex-shrink-0">{actions}</div>
          )}
        </header>
      )}
      <div className={`relative ${bodyClassName}`}>{children}</div>
    </motion.section>
  )
}
