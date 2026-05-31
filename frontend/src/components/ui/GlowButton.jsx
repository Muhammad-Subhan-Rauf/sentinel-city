import { motion } from 'framer-motion'

/**
 * GlowButton — primary CTA with a neon glow + press feedback.
 *
 * Variants:
 *   info    — cyan (default — telemetry / confirm)
 *   accent  — orange (trigger disaster)
 *   danger  — red (destructive / emergency)
 *   ghost   — transparent until hover
 *
 * Touch target ≥ 36px (UX guideline #2: touch-target-size).
 * Loading state: disables clicks, shows spinner.
 */
const VARIANTS = {
  info: {
    base: 'bg-sentinel-info/15 text-sentinel-info border-sentinel-info/40',
    hover: 'hover:bg-sentinel-info/25 hover:border-sentinel-info/70 hover:shadow-glow',
  },
  accent: {
    base: 'bg-sentinel-accent/15 text-sentinel-accent border-sentinel-accent/40',
    hover:
      'hover:bg-sentinel-accent/25 hover:border-sentinel-accent/70 hover:shadow-glow-accent',
  },
  danger: {
    base: 'bg-sentinel-danger/15 text-sentinel-danger border-sentinel-danger/40',
    hover:
      'hover:bg-sentinel-danger/25 hover:border-sentinel-danger/70 hover:shadow-glow-danger',
  },
  ghost: {
    base: 'bg-transparent text-sentinel-textDim border-white/[0.06]',
    hover: 'hover:bg-white/[0.04] hover:text-sentinel-text hover:border-white/[0.12]',
  },
  solid: {
    base: 'bg-sentinel-info text-sentinel-bg border-transparent font-semibold',
    hover: 'hover:bg-sentinel-infoHover hover:shadow-glow',
  },
}

const SIZES = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-[13px]',
  lg: 'h-11 px-5 text-sm',
}

export default function GlowButton({
  variant = 'info',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  iconRight,
  children,
  className = '',
  ariaLabel,
  ...rest
}) {
  const v = VARIANTS[variant] ?? VARIANTS.info
  const s = SIZES[size] ?? SIZES.md
  const isDisabled = disabled || loading

  return (
    <motion.button
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      whileHover={isDisabled ? undefined : { y: -1 }}
      disabled={isDisabled}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={`
        inline-flex items-center justify-center gap-2
        rounded-lg border
        ${v.base} ${!isDisabled ? v.hover : ''} ${s}
        transition-all duration-200
        ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        focus-visible:outline-2 focus-visible:outline-sentinel-info focus-visible:outline-offset-2
        ${className}
      `}
      {...rest}
    >
      {loading ? (
        <Spinner />
      ) : (
        <>
          {icon && <span aria-hidden="true">{icon}</span>}
          {children && <span className="truncate">{children}</span>}
          {iconRight && <span aria-hidden="true">{iconRight}</span>}
        </>
      )}
    </motion.button>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
