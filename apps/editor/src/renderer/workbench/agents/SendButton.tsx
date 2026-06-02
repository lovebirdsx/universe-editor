import { ArrowUp } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSession.js'
import styles from './agents.module.css'

const SIZE = 26
const CENTER = SIZE / 2
const STROKE = 2
const RADIUS = SIZE / 2 - STROKE / 2 - 1
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Circular Send control. The outer ring renders the session's context-window
 * usage as a progress arc; the center holds a send icon. While a turn is running
 * a spinning overlay arc signals activity — but the button stays a send button
 * so the user can dispatch a steering message mid-turn. Interrupting the turn is
 * handled separately by the StopButton / Esc.
 */
export function SendButton({
  session,
  running,
  disabled,
  onSend,
}: {
  session: IAcpSession
  running: boolean
  disabled: boolean
  onSend: () => void
}) {
  const usage = useObservable(session.usage)
  const hasUsage = usage !== undefined && usage.size > 0
  const pct = hasUsage ? clamp01(usage.used / usage.size) : 0
  const pctInt = Math.round(pct * 100)
  const near = pct >= 0.9

  const parts: string[] = []
  parts.push(
    running
      ? localize('acp.send.running', 'Running · send to steer')
      : localize('acp.send.idle', 'Send (Enter)'),
  )
  if (hasUsage) {
    parts.push(
      localize('acp.usage.tokens', 'Context: {used} / {size} tokens ({pct}%)', {
        used: usage.used.toLocaleString(),
        size: usage.size.toLocaleString(),
        pct: pctInt,
      }),
    )
    if (usage.cost) {
      parts.push(
        localize('acp.usage.cost', 'Cost: {amount} {currency}', {
          amount: usage.cost.amount,
          currency: usage.cost.currency,
        }),
      )
    }
  } else {
    parts.push(localize('acp.usage.unavailable', 'Context usage unavailable'))
  }
  const title = parts.join('\n')

  // Empty input is the only non-interactive state — the button always sends,
  // even while a turn is running (mid-turn steering).
  const inert = disabled

  return (
    <button
      type="button"
      className={styles['sendButtonCircle']}
      disabled={inert}
      title={title}
      aria-label={title}
      onClick={() => (inert ? undefined : onSend())}
      data-testid="acp-prompt-send"
    >
      <svg
        className={styles['sendButtonRing']}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="var(--color-border, #555)"
          strokeWidth={STROKE}
        />
        {pct > 0 ? (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke={near ? 'var(--color-badge-error, #a1260d)' : 'var(--color-button-bg, #0e639c)'}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - pct)}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
            data-testid="acp-usage-progress"
          />
        ) : null}
      </svg>
      {running ? (
        <svg
          className={styles['sendButtonSpin']}
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          aria-hidden="true"
        >
          <circle
            className={styles['sendButtonSpinArc']}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="var(--color-button-bg, #0e639c)"
            strokeWidth={STROKE}
            strokeLinecap="butt"
            strokeDasharray={`${CIRCUMFERENCE * 0.25} ${CIRCUMFERENCE * 0.75}`}
          />
        </svg>
      ) : null}
      <span className={styles['sendButtonIcon']} aria-hidden="true">
        <ArrowUp size={16} />
      </span>
    </button>
  )
}
