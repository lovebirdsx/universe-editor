import { useState } from 'react'
import type { MobileUsage } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'

const SIZE = 12
const STROKE = 2
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** Same threshold the desktop send-button ring turns red at. */
const NEAR_LIMIT_RATIO = 0.9

/** Compact token count: 860 / 84k / 1.2M. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${trimFixed(value / 1000)}k`
  return `${trimFixed(value / 1_000_000)}M`
}

function trimFixed(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}

/**
 * Context-window usage as a tiny ring + percentage; tapping toggles the raw
 * `used/size` counts since phones have no hover tooltip.
 */
export function ContextUsageMeter({ usage }: { readonly usage: MobileUsage | undefined }) {
  const [detailed, setDetailed] = useState(false)
  if (usage === undefined || usage.size <= 0) return null
  const ratio = Math.min(Math.max(usage.used / usage.size, 0), 1)
  const percent = Math.round(ratio * 100)
  const near = ratio >= NEAR_LIMIT_RATIO
  const used = formatTokens(usage.used)
  const size = formatTokens(usage.size)
  return (
    <button
      type="button"
      className={`context-usage${near ? ' context-usage--near' : ''}`}
      data-testid="context-usage"
      aria-label={strings.contextUsageLabel(used, size, percent)}
      aria-pressed={detailed}
      onClick={() => setDetailed((value) => !value)}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="context-usage__track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} />
        {ratio > 0 && (
          <circle
            className="context-usage__arc"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        )}
      </svg>
      <span>{detailed ? `${used}/${size}` : `${percent}%`}</span>
    </button>
  )
}
