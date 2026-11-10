import type {
  MobileSessionBucket,
  MobileSessionHistoryEntry,
  MobileSessionRef,
  MobileSessionSummary,
} from '@universe-editor/mobile-protocol'
import { localRefKey } from '../state/refs.js'
import { strings } from '../strings.js'

export type SessionCatalogFilter = 'all' | 'live' | 'closed'
export type SessionCatalogDateBucket = 'today' | 'yesterday' | 'earlier'

/**
 * One row per durable session. The inbox only knows sessions that are live
 * right now; history adds resumable rows from every open PC window and from
 * recently opened (closed) workspaces. Merging by durable id keeps a live
 * session from showing up twice and lets a tapped live row open directly
 * instead of going through `openSession` again.
 */
export interface SessionCatalogRow {
  readonly key: string
  readonly durableId: string | undefined
  readonly windowId: number | undefined
  /** Closed-workspace row: the workspace to open before resuming. */
  readonly folder: string | undefined
  readonly authority: string | undefined
  readonly title: string
  readonly firstPrompt: string | undefined
  readonly agentLabel: string
  readonly workspaceName: string
  readonly updatedAt: number
  readonly pinned: boolean
  readonly live: boolean
  readonly status: MobileSessionBucket | undefined
  readonly ref: MobileSessionRef | undefined
}

export interface SessionCatalogGroup {
  readonly bucket: SessionCatalogDateBucket
  readonly label: string
  readonly rows: readonly SessionCatalogRow[]
}

export interface SessionCatalogCounts {
  readonly all: number
  readonly live: number
  readonly closed: number
}

const DATE_BUCKET_LABELS: Readonly<Record<SessionCatalogDateBucket, string>> = {
  today: strings.sessionsGroupToday,
  yesterday: strings.sessionsGroupYesterday,
  earlier: strings.sessionsGroupEarlier,
}

export function buildSessionCatalog(
  history: readonly MobileSessionHistoryEntry[],
  summaries: readonly MobileSessionSummary[],
): readonly SessionCatalogRow[] {
  const liveByDurable = new Map<string, MobileSessionSummary>()
  const liveWithoutDurable: MobileSessionSummary[] = []
  for (const summary of summaries) {
    if (summary.sideTaskOf !== undefined) continue
    const durableId = summary.ref.durableId
    if (durableId === undefined) {
      liveWithoutDurable.push(summary)
      continue
    }
    const previous = liveByDurable.get(durableId)
    if (previous === undefined || summary.updatedAt > previous.updatedAt) {
      liveByDurable.set(durableId, summary)
    }
  }

  const rows = new Map<string, SessionCatalogRow>()
  for (const entry of history) {
    const live = liveByDurable.get(entry.durableId)
    if (live !== undefined) liveByDurable.delete(entry.durableId)
    rows.set(`d:${entry.durableId}`, {
      key: `d:${entry.durableId}`,
      durableId: entry.durableId,
      windowId: live?.ref.windowId ?? entry.windowId,
      folder: entry.folder,
      authority: live?.authority ?? entry.authority,
      title: pickTitle(live?.title, entry.title, entry.durableId),
      firstPrompt: entry.firstPrompt,
      agentLabel: pickAgent(live?.agentName, entry.agentName, entry.agentId),
      workspaceName: live?.workspaceName ?? entry.workspaceName,
      updatedAt: live === undefined ? entry.lastUsedAt : Math.max(entry.lastUsedAt, live.updatedAt),
      pinned: entry.pinned === true,
      live: live !== undefined,
      status: live?.bucket,
      ref: live?.ref,
    })
  }

  // Live sessions with no history row yet (brand new, or never prompted) still
  // belong in the list; they just have no first prompt to show.
  for (const [durableId, live] of liveByDurable) {
    rows.set(`d:${durableId}`, {
      key: `d:${durableId}`,
      durableId,
      windowId: live.ref.windowId,
      folder: undefined,
      authority: live.authority,
      title: pickTitle(live.title, undefined, durableId),
      firstPrompt: undefined,
      agentLabel: pickAgent(live.agentName, undefined, live.agentId),
      workspaceName: live.workspaceName,
      updatedAt: live.updatedAt,
      pinned: false,
      live: true,
      status: live.bucket,
      ref: live.ref,
    })
  }

  for (const live of liveWithoutDurable) {
    const key = `l:${localRefKey(live.ref)}`
    rows.set(key, {
      key,
      durableId: undefined,
      windowId: live.ref.windowId,
      folder: undefined,
      authority: live.authority,
      title: pickTitle(live.title, undefined, key),
      firstPrompt: undefined,
      agentLabel: pickAgent(live.agentName, undefined, live.agentId),
      workspaceName: live.workspaceName,
      updatedAt: live.updatedAt,
      pinned: false,
      live: true,
      status: live.bucket,
      ref: live.ref,
    })
  }

  return [...rows.values()].sort(compareRows)
}

export function filterSessionCatalog(
  rows: readonly SessionCatalogRow[],
  filter: SessionCatalogFilter,
  query: string,
): readonly SessionCatalogRow[] {
  const needle = query.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (filter === 'live' && !row.live) return false
    if (filter === 'closed' && row.live) return false
    if (needle === '') return true
    return rowSearchText(row).includes(needle)
  })
}

export function countSessionCatalog(rows: readonly SessionCatalogRow[]): SessionCatalogCounts {
  let live = 0
  for (const row of rows) if (row.live) live += 1
  return { all: rows.length, live, closed: rows.length - live }
}

/** Rows are already sorted; the group order is fixed and empty days are omitted. */
export function groupSessionCatalog(
  rows: readonly SessionCatalogRow[],
  now = Date.now(),
): readonly SessionCatalogGroup[] {
  const todayStart = startOfDay(now)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  const yesterdayTime = yesterdayStart.getTime()

  const buckets = new Map<SessionCatalogDateBucket, SessionCatalogRow[]>()
  for (const row of rows) {
    const bucket: SessionCatalogDateBucket =
      row.updatedAt >= todayStart
        ? 'today'
        : row.updatedAt >= yesterdayTime
          ? 'yesterday'
          : 'earlier'
    const bucketRows = buckets.get(bucket)
    if (bucketRows === undefined) buckets.set(bucket, [row])
    else bucketRows.push(row)
  }

  return (['today', 'yesterday', 'earlier'] as const).flatMap((bucket) => {
    const bucketRows = buckets.get(bucket)
    return bucketRows === undefined
      ? []
      : [{ bucket, label: DATE_BUCKET_LABELS[bucket], rows: bucketRows }]
  })
}

function pickTitle(
  liveTitle: string | undefined,
  historyTitle: string | undefined,
  fallback: string,
): string {
  if (liveTitle !== undefined && liveTitle.trim() !== '') return liveTitle
  if (historyTitle !== undefined && historyTitle.trim() !== '') return historyTitle
  return fallback
}

function pickAgent(
  liveName: string | undefined,
  historyName: string | undefined,
  agentId: string,
): string {
  if (liveName !== undefined && liveName !== '') return liveName
  if (historyName !== undefined && historyName !== '') return historyName
  return agentId === '' ? strings.agentLabel : agentId
}

function rowSearchText(row: SessionCatalogRow): string {
  return [row.title, row.firstPrompt ?? '', row.agentLabel, row.workspaceName]
    .join('\n')
    .toLocaleLowerCase()
}

function compareRows(a: SessionCatalogRow, b: SessionCatalogRow): number {
  const pinned = Number(b.pinned) - Number(a.pinned)
  if (pinned !== 0) return pinned
  const updated = b.updatedAt - a.updatedAt
  if (updated !== 0) return updated
  return a.key.localeCompare(b.key)
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
