import { useEffect, useRef } from 'react'
import { animate, useInView, useMotionValue, useTransform, useReducedMotion } from 'framer-motion'
import { motion } from 'framer-motion'

/**
 * AnimatedCounter — springs a number from its previous value to a new one.
 * Tabular figures prevent column jitter.
 */
export default function AnimatedCounter({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 0.6,
  className = '',
}) {
  const reduceMotion = useReducedMotion()
  const mv = useMotionValue(value)
  const display = useTransform(mv, (n) => format(n))
  const ref = useRef(null)
  const inView = useInView(ref, { once: false, amount: 0.01 })

  useEffect(() => {
    if (reduceMotion || !inView) {
      mv.set(value)
      return
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
    })
    return () => controls.stop()
  }, [value, mv, duration, reduceMotion, inView])

  return (
    <motion.span ref={ref} className={`tabular ${className}`}>
      {display}
    </motion.span>
  )
}
