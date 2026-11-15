import type { MobileClient } from '../state/mobileClient.js'
import { strings } from '../strings.js'
import { useElapsedTime } from './elapsed.js'
import type { MobileHiddenActivity } from './sessionDisplay.js'

export interface TimelineActivityProps {
  readonly activity: MobileHiddenActivity
  readonly client: Pick<MobileClient, 'serverNow'>
  readonly testId?: string
  readonly className?: string
}

/**
 * The phone's counterpart of the desktop `TimelineHiddenActivity`: a spinner plus
 * a single-line summary of the slot the only-message filter hid — at the bottom
 * of the timeline and inside a running sub-agent card. The stopwatch state lives
 * here so its per-second tick re-renders this row alone, not the timeline.
 */
export function TimelineActivity({
  activity,
  client,
  testId = 'session-timeline-activity',
  className,
}: TimelineActivityProps) {
  const elapsed = useElapsedTime(
    activity.kind === 'tool',
    activity.kind === 'tool' ? activity.startedAt : undefined,
    activity.kind === 'tool'
      ? activity.durationMs
      : activity.kind === 'settledTool'
        ? activity.tool.durationMs
        : undefined,
    () => client.serverNow(),
  )
  const primary = activity.kind === 'tool' ? activity.title : strings.activityThinking
  const secondary = activityDetail(activity, elapsed)

  return (
    <div
      className={className !== undefined ? `timeline-activity ${className}` : 'timeline-activity'}
      data-testid={testId}
      role="status"
      aria-atomic="false"
    >
      <span className="spinner spinner--small timeline-activity__spinner" aria-hidden="true" />
      <div className="timeline-activity__body">
        <span className="timeline-activity__primary" data-testid={`${testId}-primary`}>
          {primary}
        </span>
        {/* Always mounted: the CSS slot keeps the row height stable while activity swaps. */}
        <span className="timeline-activity__detail" data-testid={`${testId}-detail`}>
          {secondary}
        </span>
      </div>
    </div>
  )
}

function joinActivityParts(...parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0)
  return kept.length > 0 ? kept.join(' · ') : undefined
}

function activityDetail(
  activity: MobileHiddenActivity,
  elapsed: string | null,
): string | undefined {
  if (activity.kind === 'thinking') return activity.detail
  if (activity.kind === 'tool') {
    return joinActivityParts(activity.detail, elapsed ?? undefined)
  }
  const { tool } = activity
  const previous = strings.activityPrevious(tool.title)
  const status =
    tool.status === 'failed'
      ? tool.reason !== undefined && tool.reason.length > 0
        ? strings.activityFailedWithReason(tool.reason)
        : strings.activityFailed
      : tool.status === 'cancelled' && (tool.reason === undefined || tool.reason.length === 0)
        ? strings.activityCancelled
        : tool.reason
  return joinActivityParts(previous, status, elapsed ?? undefined)
}
