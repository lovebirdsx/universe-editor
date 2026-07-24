/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ResurrectionCard — a system status card marking a wedged-session
 *  resurrection on the timeline. When a cancelled turn leaves the agent
 *  genuinely unresponsive, the adapter kills the wedged subprocess and resumes
 *  the session from its on-disk transcript; this card shows a spinner + live
 *  stopwatch while `running`, then settles into `success`/`failed` so the user
 *  understands why the follow-up answer took a few seconds.
 *--------------------------------------------------------------------------------------------*/

import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import type { AcpResurrection } from '../../services/acp/acpSession.js'
import { useElapsedTime } from './elapsedTime.js'
import styles from './agents.module.css'

const ICON_SIZE = 14

export function ResurrectionCard({
  resurrection,
  dataTimelineKey,
  dataStickyKey,
}: {
  resurrection: AcpResurrection
  dataTimelineKey: string
  dataStickyKey: string
}) {
  const { icon, text } = content(resurrection)
  const elapsed = useElapsedTime(
    resurrection.phase === 'running',
    resurrection.startedAt,
    resurrection.durationMs,
  )
  return (
    <div
      className={styles['compactionCard']}
      data-phase={resurrection.phase}
      data-timeline-key={dataTimelineKey}
      data-sticky-key={dataStickyKey}
      data-sticky-depth="0"
      data-testid="acp-resurrection-card"
    >
      <span className={styles['compactionIcon']} aria-hidden="true">
        {icon}
      </span>
      <span className={styles['compactionText']}>{text}</span>
      {elapsed !== null ? (
        <span className={styles['compactionTimer']} data-testid="acp-resurrection-timer">
          {elapsed}
        </span>
      ) : null}
    </div>
  )
}

function content(resurrection: AcpResurrection): { icon: React.ReactNode; text: string } {
  switch (resurrection.phase) {
    case 'running':
      return {
        icon: <Loader2 size={ICON_SIZE} className={styles['spin']} />,
        text: localize(
          'acp.resurrection.running',
          'Agent unresponsive — resuming the session from its transcript…',
        ),
      }
    case 'success':
      return {
        icon: <CheckCircle2 size={ICON_SIZE} />,
        text:
          resurrection.replayCount !== undefined && resurrection.replayCount > 0
            ? localize(
                'acp.resurrection.successReplay',
                'Session resumed — replayed {count} queued prompt(s)',
                { count: resurrection.replayCount },
              )
            : localize('acp.resurrection.success', 'Session resumed'),
      }
    case 'failed':
      return {
        icon: <CircleAlert size={ICON_SIZE} />,
        text: resurrection.reason
          ? localize('acp.resurrection.failedReason', 'Session resume failed: {reason}', {
              reason: resurrection.reason,
            })
          : localize('acp.resurrection.failed', 'Session resume failed'),
      }
  }
}
