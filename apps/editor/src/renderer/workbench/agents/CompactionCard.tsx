/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CompactionCard — a system status card marking a context-compaction event on
 *  the timeline. Replaces the old plain-text "Compacting…" chunks that used to
 *  leak into the assistant message stream: a spinner while `running`, a settled
 *  marker on `success`, and the failure reason on `failed`.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { AcpCompaction } from '../../services/acp/acpSession.js'
import { formatElapsed } from './elapsedTime.js'
import styles from './agents.module.css'

const ICON_SIZE = 14

export function CompactionCard({
  compaction,
  dataTimelineKey,
  dataStickyKey,
}: {
  compaction: AcpCompaction
  dataTimelineKey: string
  dataStickyKey: string
}) {
  const { icon, text } = content(compaction)
  const { elapsed, percent } = useCompactionProgress(compaction)
  return (
    <div
      className={styles['compactionCard']}
      data-phase={compaction.phase}
      data-timeline-key={dataTimelineKey}
      data-sticky-key={dataStickyKey}
      data-sticky-depth="0"
      data-testid="acp-compaction-card"
    >
      <span className={styles['compactionIcon']} aria-hidden="true">
        {icon}
      </span>
      <span className={styles['compactionText']}>{text}</span>
      {percent !== null ? (
        <span
          className={styles['compactionProgress']}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className={styles['compactionProgressFill']} style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      {elapsed !== null ? (
        <span className={styles['compactionTimer']} data-testid="acp-compaction-timer">
          {percent !== null ? `${percent}% · ${elapsed}` : elapsed}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The live progress suffix. The SDK compaction is an atomic summarization call
 * with no real progress signal, so `percent` is a time-based estimate that
 * eases toward — but never reaches — 100% while `running` (mirroring the CLI's
 * compaction percentage); it clears on settle. When past compactions have been
 * timed (`expectedDurationMs`), the curve is tuned so the bar hits ~90% around
 * that historically typical finish time; without any samples it falls back to a
 * fixed time constant. `elapsed` is a live stopwatch while running, frozen at
 * the recorded `durationMs` once settled.
 */
function useCompactionProgress(compaction: AcpCompaction): {
  elapsed: string | null
  percent: number | null
} {
  const running = compaction.phase === 'running'
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || compaction.startedAt === undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running, compaction.startedAt])
  if (running) {
    if (compaction.startedAt === undefined) return { elapsed: null, percent: null }
    const ms = Math.max(0, Date.now() - compaction.startedAt)
    return {
      elapsed: formatElapsed(ms),
      percent: estimatePercent(ms, compaction.expectedDurationMs),
    }
  }
  if (compaction.durationMs === undefined) return { elapsed: null, percent: null }
  return { elapsed: formatElapsed(compaction.durationMs), percent: null }
}

/** Fallback time constant (ms) when no history exists; ~τ elapsed ≈ 63%. */
const PROGRESS_TAU_MS = 6000
/** ln(1 / (1 - 0.9)) — elapsing one expected-duration reaches 90% on the asymptotic curve. */
const EXPECTED_CURVE_K = 2.302585

/**
 * Asymptotic time-based estimate that approaches but never reaches 100%. With a
 * recorded `expectedDurationMs`, the curve is scaled so `ms === expected` lands
 * at ~90% — grounding the bar in observed timing; otherwise it eases off the
 * fixed {@link PROGRESS_TAU_MS}. Capped at 99 so a slow run past the estimate
 * still reads as in-progress rather than stuck at 100%.
 */
function estimatePercent(ms: number, expectedDurationMs?: number): number {
  const tau =
    expectedDurationMs !== undefined && expectedDurationMs > 0
      ? expectedDurationMs / EXPECTED_CURVE_K
      : PROGRESS_TAU_MS
  const p = (1 - Math.exp(-ms / tau)) * 100
  return Math.min(99, Math.round(p))
}

function content(compaction: AcpCompaction): { icon: React.ReactNode; text: string } {
  switch (compaction.phase) {
    case 'running':
      return {
        icon: <Loader2 size={ICON_SIZE} className={styles['spin']} />,
        text: localize('acp.compaction.running', 'Compacting context…'),
      }
    case 'success':
      return {
        icon: <CheckCircle2 size={ICON_SIZE} />,
        text: localize('acp.compaction.success', 'Context compacted'),
      }
    case 'failed':
      return {
        icon: <CircleAlert size={ICON_SIZE} />,
        text: compaction.reason
          ? localize('acp.compaction.failedReason', 'Compaction failed: {reason}', {
              reason: compaction.reason,
            })
          : localize('acp.compaction.failed', 'Compaction failed'),
      }
  }
}
