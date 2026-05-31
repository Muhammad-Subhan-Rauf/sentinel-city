/**
 * Skeleton — shimmer placeholder used while async cells load.
 * Reserves layout space to prevent CLS (UX guideline #3: content-jumping).
 */
export default function Skeleton({
  className = '',
  height,
  width = '100%',
  rounded = 'rounded-md',
}) {
  return (
    <div
      className={`shimmer ${rounded} ${className}`}
      style={{ height, width }}
      aria-hidden="true"
    />
  )
}

export function SkeletonBlock({ lines = 3, gap = 'gap-2', className = '' }) {
  return (
    <div className={`flex flex-col ${gap} ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={i === 0 ? 14 : 10}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  )
}
