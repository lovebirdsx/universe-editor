/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CompactionThresholdChip — a pre-warning shown in PromptInput's action row as
 *  the context window fills toward Claude's auto-compaction threshold. Subscribes
 *  to `session.usage` (whose `size` already reflects the effective, auto-compact
 *  window); renders nothing below 80% so it never occupies space when there's
 *  nothing to warn about, and turns red past 90%.
 *--------------------------------------------------------------------------------------------*/

import { AlertTriangle } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSession.js'
import styles from './agents.module.css'

const WARN_THRESHOLD = 0.8
const DANGER_THRESHOLD = 0.9

export function CompactionThresholdChip({ session }: { session: IAcpSession }) {
  const usage = useObservable(session.usage)
  if (usage === undefined || usage.size <= 0) return null
  const ratio = usage.used / usage.size
  if (ratio < WARN_THRESHOLD) return null
  const pct = Math.round(ratio * 100)
  const danger = ratio >= DANGER_THRESHOLD
  return (
    <span
      className={styles['compactionChip']}
      data-state={danger ? 'danger' : 'warn'}
      data-testid="acp-compaction-chip"
      title={localize(
        'acp.compaction.chip.title',
        'Context at {pct}% — nearing automatic compaction',
        { pct },
      )}
    >
      <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles['compactionChipText']}>
        {localize('acp.compaction.chip', 'Context {pct}% · nearing auto-compaction', { pct })}
      </span>
    </span>
  )
}
