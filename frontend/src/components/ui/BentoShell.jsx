import { motion } from 'framer-motion'

/**
 * BentoShell — top-level layout grid for the operator console.
 *
 * Grid regions (desktop ≥1024px):
 *   topbar   — full-width command strip (city, status, alerts)
 *   stage    — primary working surface (the map)
 *   rail     — right column with telemetry cells
 *   dock     — collapsible bottom row (calls / route / AI logs)
 *
 * On ≥1920px (3xl) the rail widens. On ≥2560px (4xl) the shell is
 * centered with a max-width so content doesn't stretch on ultra-wide.
 */
export default function BentoShell({ topbar, stage, rail, dock }) {
  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div
        className="
          relative h-full w-full
          mx-auto max-w-[2560px]
          grid gap-2 p-2
          grid-cols-1 grid-rows-[auto_1fr]
          lg:grid-cols-[1fr_360px] lg:grid-rows-[auto_1fr_auto]
          3xl:grid-cols-[1fr_420px]
          4xl:grid-cols-[1fr_480px]
        "
        style={{ zIndex: 1 }}
      >
        {topbar && (
          <div className="col-span-full">
            {topbar}
          </div>
        )}

        <div className="relative min-h-0">
          {stage}
        </div>

        <aside className="relative min-h-0 overflow-hidden hidden lg:flex flex-col gap-2">
          {rail}
        </aside>

        {dock && (
          <div className="col-span-full">
            {dock}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Stagger container for BentoCell children — apply to the rail or any
 * grid that wants its children to mount with a cascading entrance.
 *
 * Children must be <BentoCell> (or any motion-aware) so the variants
 * propagate. Reduced-motion is respected by Framer Motion automatically.
 */
export function BentoStagger({ children, delayStep = 0.05, className }) {
  const variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: delayStep, delayChildren: 0.05 },
    },
  }
  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  )
}
