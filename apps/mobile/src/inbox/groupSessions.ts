import { MOBILE_SESSION_BUCKETS, type MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { strings } from '../strings.js'

export type BucketLabel = string

const BUCKET_LABELS: Readonly<Record<string, BucketLabel>> = {
  input_needed: strings.bucketInputNeeded,
  in_progress: strings.bucketInProgress,
  failed: strings.bucketFailed,
  completed: strings.bucketCompleted,
}

export interface InboxGroup {
  readonly bucket: string
  readonly label: BucketLabel
  readonly sessions: readonly MobileSessionSummary[]
}

/**
 * The inbox lists normal sessions only. Side-task rows stay in the store so
 * notifications / deep links / snapshots still resolve, but their entry point
 * is the parent's side-task list.
 */
export function selectInboxSessions(
  sessions: readonly MobileSessionSummary[],
): readonly MobileSessionSummary[] {
  return sessions.filter((session) => session.sideTaskOf === undefined)
}

/** Ordered by urgency; empty buckets are omitted so the first screen stays short. */
export function groupSessions(sessions: readonly MobileSessionSummary[]): InboxGroup[] {
  return MOBILE_SESSION_BUCKETS.map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket] ?? bucket,
    sessions: sessions
      .filter((session) => session.bucket === bucket)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  })).filter((group) => group.sessions.length > 0)
}

export function formatUpdatedAt(updatedAt: number, now = Date.now()): string {
  const elapsedMinutes = Math.max(0, Math.floor((now - updatedAt) / 60_000))
  if (elapsedMinutes < 1) return strings.sessionUpdatedJustNow
  if (elapsedMinutes < 60) return strings.sessionUpdatedMinutesAgo(elapsedMinutes)
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return strings.sessionUpdatedHoursAgo(elapsedHours)
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return strings.sessionUpdatedDaysAgo(elapsedDays)
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(updatedAt))
}
