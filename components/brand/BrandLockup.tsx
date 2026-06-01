type BrandLockupProps = {
  size?: number
  onDark?: boolean
  showWordmark?: boolean
  className?: string
}

export function BrandLockup({
  size = 32,
  onDark = false,
  showWordmark = true,
  className = "",
}: BrandLockupProps) {
  const wordSize = Math.round(size * 0.72)

  const checkColor = onDark ? "#ffffff" : "#13182a"
  const beforeColor = onDark ? "#9aa1b8" : "#8b909e"
  const clickColor = "#6d5ef0"
  const markColor = "#6d5ef0"

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ color: markColor, flexShrink: 0 }}
      >
        <circle cx="20" cy="20" r="15" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
        <circle cx="20" cy="20" r="9.5" stroke="currentColor" strokeWidth="2.5" opacity="0.55" />
        <circle cx="20" cy="20" r="4" fill="currentColor" />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontSize: wordSize,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "baseline",
          }}
        >
          <span style={{ color: checkColor, fontWeight: 600 }}>check</span>
          <span style={{ color: beforeColor, fontWeight: 400 }}>before</span>
          <span style={{ color: clickColor, fontWeight: 600 }}>click</span>
        </span>
      )}
    </span>
  )
}
