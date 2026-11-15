/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The tail activity line shown while a display mode hides the streaming slot —
 *  at the bottom of the chat timeline and at the bottom of a running sub-agent
 *  card. Data comes from `getHiddenActivity` / `getSubagentHiddenActivity`.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { Loader2 } from 'lucide-react'
import { useElapsedTime } from './elapsedTime.js'
import type { HiddenActivity } from './timelineDisplay.js'
import styles from './agents.module.css'

function joinActivityParts(...parts: readonly (string | null | undefined)[]): string | undefined {
  const kept = parts.filter(
    (part): part is string => part !== undefined && part !== null && part.length > 0,
  )
  return kept.length > 0 ? kept.join(' · ') : undefined
}

function hiddenActivityDetail(
  activity: HiddenActivity,
  elapsed: string | null,
): string | undefined {
  if (activity.kind === 'thinking') return activity.detail
  if (activity.kind === 'tool') return joinActivityParts(activity.detail, elapsed)
  const { tool } = activity
  const previous = localize('acp.collapse.activity.previous', 'Previous: {title}', {
    title: tool.title,
  })
  const status =
    tool.status === 'failed'
      ? tool.reason !== undefined && tool.reason.length > 0
        ? localize('acp.collapse.activity.failedWithReason', 'failed: {reason}', {
            reason: tool.reason,
          })
        : localize('acp.collapse.activity.failed', 'failed')
      : tool.status === 'cancelled' && (tool.reason === undefined || tool.reason.length === 0)
        ? localize('acp.collapse.activity.cancelled', 'cancelled')
        : tool.reason
  return joinActivityParts(previous, status, elapsed)
}

export function TimelineHiddenActivity({
  activity,
  testId = 'acp-timeline-hidden-activity',
  className,
}: {
  activity: HiddenActivity
  testId?: string
  className?: string | undefined
}) {
  const elapsed = useElapsedTime(
    activity.kind === 'tool',
    activity.kind === 'tool' ? activity.startedAt : undefined,
    activity.kind === 'tool'
      ? activity.durationMs
      : activity.kind === 'settledTool'
        ? activity.tool.durationMs
        : undefined,
  )
  const primary =
    activity.kind === 'tool'
      ? activity.title
      : localize('acp.collapse.activity.thinking', 'Thinking…')
  const secondary = hiddenActivityDetail(activity, elapsed)

  return (
    <div
      className={
        className !== undefined
          ? `${styles['timelineHiddenActivity']} ${className}`
          : styles['timelineHiddenActivity']
      }
      data-testid={testId}
      role="status"
      aria-atomic="false"
    >
      <Loader2 size={12} strokeWidth={1.75} className={styles['spin']} aria-hidden="true" />
      <div className={styles['timelineHiddenActivityBody']}>
        <span
          className={styles['timelineHiddenActivityPrimary']}
          data-testid={`${testId}-primary`}
          data-tooltip={primary}
        >
          {primary}
        </span>
        {secondary !== undefined && (
          <span
            className={styles['timelineHiddenActivityDetail']}
            data-testid={`${testId}-detail`}
            data-tooltip={secondary}
          >
            {secondary}
          </span>
        )}
      </div>
    </div>
  )
}
