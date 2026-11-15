/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure presentation helpers for trigger summaries: wording, workspace grouping,
 *  badges and the "needs me" count used by the manager and the status bar.
 *  No DI, no DOM — unit-testable and shared by both surfaces.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type {
  TriggerEventName,
  TriggerSourceConfig,
  TriggerSourceType,
  TriggerStatus,
  TriggerSummary,
} from './types.js'

/** Display name per editor-pushed event; adding an event means adding one entry. */
const TRIGGER_EVENT_LABELS: Record<TriggerEventName, string> = {
  'swarm.reviewNeedsAction': localize(
    'triggers.event.swarmReviewNeedsAction',
    'Swarm review that needs action',
  ),
}

export function triggerEventLabel(event: TriggerEventName): string {
  return TRIGGER_EVENT_LABELS[event]
}

export function triggerStatusLabel(status: TriggerStatus): string {
  switch (status) {
    case 'disabled':
      return localize('triggers.status.disabled', 'Disabled')
    case 'idle':
      return localize('triggers.status.idle', 'Idle')
    case 'running':
      return localize('triggers.status.running', 'Running')
    case 'paused':
      return localize('triggers.status.paused', 'Paused')
    case 'invalid':
      return localize('triggers.status.invalid', 'Invalid')
    case 'needs-confirmation':
      return localize('triggers.status.needsConfirmation', 'Needs confirmation')
  }
}

export function triggerSourceLabel(sourceType: TriggerSourceType | 'unknown'): string {
  switch (sourceType) {
    case 'manual':
      return localize('triggers.source.manual', 'Manual')
    case 'schedule':
      return localize('triggers.source.schedule', 'Schedule')
    case 'poll':
      return localize('triggers.source.poll', 'Command poll')
    case 'event':
      return localize('triggers.source.event', 'Event')
    case 'unknown':
      return localize('triggers.source.unknown', 'Unknown source')
  }
}

/**
 * A trigger is confirmed once, bound to its full definition; that single
 * confirmation also covers a bypass-class mode, so there is no second gate.
 */
export function triggerNeedsConfirmation(summary: TriggerSummary): boolean {
  if (summary.status === 'invalid') return false
  return !summary.activationConfirmed
}

export interface TriggerWorkspaceGroup {
  readonly workspace: string
  readonly workspaceName: string
  readonly triggers: readonly TriggerSummary[]
}

/**
 * Groups in first-seen order. Callers that want attention-first groups pass a
 * list reordered with `sortTriggersForDisplay`; a group's first trigger then
 * decides where the whole group appears.
 */
export function groupTriggersByWorkspace(
  list: readonly TriggerSummary[],
): readonly TriggerWorkspaceGroup[] {
  const groups = new Map<string, { name: string; triggers: TriggerSummary[] }>()
  for (const summary of list) {
    const group = groups.get(summary.workspace)
    if (group === undefined) {
      groups.set(summary.workspace, { name: summary.workspaceName, triggers: [summary] })
    } else {
      group.triggers.push(summary)
    }
  }
  return [...groups].map(([workspace, group]) => ({
    workspace,
    workspaceName: group.name,
    triggers: group.triggers,
  }))
}

/** Short human wording for the row subtitle. */
export function summarizeTriggerSource(source: TriggerSourceConfig | undefined): string {
  if (source === undefined) return localize('triggers.source.unknown', 'Unknown source')
  switch (source.type) {
    case 'manual':
      return localize('triggers.source.manual', 'Manual')
    case 'event':
      return triggerEventLabel(source.event)
    case 'schedule':
      if (source.cron !== undefined) {
        return localize('trigger.manager.source.cron', 'Cron {cron}', { cron: source.cron })
      }
      if (source.everyMin !== undefined) {
        return localize('trigger.manager.source.everyMinutes', 'Every {count} min', {
          count: source.everyMin,
        })
      }
      return localize('triggers.source.schedule', 'Schedule')
    case 'poll':
      return localize('trigger.manager.source.pollEvery', 'Every {seconds}s', {
        seconds: source.intervalSec,
      })
  }
}

export interface TriggerSourceFact {
  readonly label: string
  readonly value: string
}

/** Label/value pairs for the Overview's "Definition" section. */
export function triggerSourceFacts(
  source: TriggerSourceConfig | undefined,
): readonly TriggerSourceFact[] {
  if (source === undefined) return []
  switch (source.type) {
    case 'manual':
      return []
    case 'event':
      return [{ label: localize('triggers.source.event', 'Event'), value: source.event }]
    case 'schedule': {
      const facts: TriggerSourceFact[] = []
      if (source.cron !== undefined) {
        facts.push({ label: localize('trigger.manager.fact.cron', 'Cron'), value: source.cron })
      }
      if (source.everyMin !== undefined) {
        facts.push({
          label: localize('trigger.manager.fact.everyMinutes', 'Interval'),
          value: localize('trigger.manager.fact.value.minutes', '{count} min', {
            count: source.everyMin,
          }),
        })
      }
      facts.push({
        label: localize('trigger.manager.fact.onMissed', 'On missed runs'),
        value:
          source.onMissed === 'skip'
            ? localize('trigger.manager.source.onMissed.skip', 'skip')
            : localize('trigger.manager.source.onMissed.catchUpOnce', 'catch up once'),
      })
      return facts
    }
    case 'poll':
      return [
        {
          label: localize('trigger.manager.fact.interval', 'Poll interval'),
          value: localize('trigger.manager.fact.value.seconds', '{seconds}s', {
            seconds: source.intervalSec,
          }),
        },
        {
          label: localize('trigger.manager.fact.command', 'Command'),
          value: source.fetch.command,
        },
        {
          label: localize('trigger.manager.fact.timeout', 'Command timeout'),
          value: localize('trigger.manager.fact.value.seconds', '{seconds}s', {
            seconds: source.fetch.timeoutSec,
          }),
        },
        {
          label: localize('trigger.manager.fact.keyField', 'Event key field'),
          value: source.keyField,
        },
      ]
  }
}

export type TriggerBadgeKind =
  | 'invalid'
  | 'offline'
  | 'needs-confirmation'
  | 'auto-paused'
  | 'running'
  | 'queued'
  | 'error'
  | 'paused'
  | 'disabled'
  | 'idle'

export interface TriggerStatusBadge {
  readonly kind: TriggerBadgeKind
  readonly label: string
  /** Paints the badge with the attention tone (badge is the only actionable hint). */
  readonly attention: boolean
}

export function triggerStatusBadge(summary: TriggerSummary): TriggerStatusBadge {
  const badge = (kind: TriggerBadgeKind, label: string, attention = false): TriggerStatusBadge => ({
    kind,
    label,
    attention,
  })
  if (summary.status === 'invalid') {
    return badge('invalid', triggerStatusLabel('invalid'), true)
  }
  if (summary.offline === true) {
    return badge('offline', localize('trigger.manager.badge.offline', 'Offline'), true)
  }
  if (triggerNeedsConfirmation(summary)) {
    return badge('needs-confirmation', triggerStatusLabel('needs-confirmation'), true)
  }
  if (summary.autoPaused) {
    return badge('auto-paused', localize('trigger.manager.badge.autoPaused', 'Auto-paused'), true)
  }
  if (summary.running > 0) {
    return badge('running', triggerStatusLabel('running'))
  }
  if (summary.queued > 0) {
    return badge('queued', localize('trigger.manager.badge.queued', 'Queued'))
  }
  if (summary.lastError !== undefined && summary.lastError.length > 0) {
    return badge('error', localize('trigger.manager.badge.error', 'Error'), true)
  }
  if (summary.paused) {
    return badge('paused', triggerStatusLabel('paused'))
  }
  if (!summary.enabled) {
    return badge('disabled', triggerStatusLabel('disabled'))
  }
  return badge('idle', triggerStatusLabel('idle'))
}

function triggerNeedsAttention(summary: TriggerSummary): boolean {
  return (
    triggerNeedsConfirmation(summary) ||
    summary.autoPaused ||
    summary.offline === true ||
    (summary.status !== 'invalid' &&
      summary.lastError !== undefined &&
      summary.lastError.length > 0)
  )
}

/**
 * Manager list buckets: action-required states first, paused/disabled last.
 * Rows inside a bucket keep their incoming order (stable sort).
 */
export function triggerDisplayRank(summary: TriggerSummary): number {
  switch (triggerStatusBadge(summary).kind) {
    case 'needs-confirmation':
    case 'invalid':
    case 'offline':
    case 'auto-paused':
    case 'error':
      return 0
    case 'running':
    case 'queued':
      return 1
    case 'idle':
      return 2
    case 'paused':
    case 'disabled':
      return 3
  }
}

/** Stable attention-first ordering; grouping after this puts active groups on top. */
export function sortTriggersForDisplay(list: readonly TriggerSummary[]): readonly TriggerSummary[] {
  return [...list].sort((a, b) => triggerDisplayRank(a) - triggerDisplayRank(b))
}

export const TRIGGER_LIST_FILTERS = ['all', 'active', 'attention', 'paused'] as const
export type TriggerListFilter = (typeof TRIGGER_LIST_FILTERS)[number]

export function isTriggerListFilter(value: unknown): value is TriggerListFilter {
  return typeof value === 'string' && (TRIGGER_LIST_FILTERS as readonly string[]).includes(value)
}

export function triggerMatchesListFilter(
  summary: TriggerSummary,
  filter: TriggerListFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'attention':
      return triggerStatusBadge(summary).attention
    case 'active': {
      // Badge first: an unconfirmed or auto-paused trigger must not leak into
      // "active" just because its raw status still says idle.
      const kind = triggerStatusBadge(summary).kind
      return kind === 'running' || kind === 'queued' || kind === 'idle'
    }
    case 'paused':
      return summary.paused
  }
}

/**
 * Space-separated terms are ANDed (case-insensitive). Only the fields a user can
 * see or copy are searched; status filtering has its own menu.
 */
export function triggerMatchesSearch(summary: TriggerSummary, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return true
  const haystack = [
    summary.name,
    summary.id,
    summary.workspaceName,
    summarizeTriggerSource(summary.source),
    summary.lastRunSummary ?? '',
    summary.lastError ?? '',
  ]
    .join('\n')
    .toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** Manual runs stay available while paused; only the hard gates block them. */
export function triggerCanRun(summary: TriggerSummary): boolean {
  return (
    summary.status !== 'invalid' &&
    summary.activationConfirmed &&
    !summary.pausedAll &&
    summary.offline !== true
  )
}

export interface TriggerCountSummary {
  readonly total: number
  readonly running: number
  readonly needsConfirmation: number
  readonly autoPaused: number
  readonly offline: number
  readonly errors: number
  /**
   * Distinct triggers with at least one problem: a trigger that is both
   * unconfirmed and auto-paused counts once, so the badge matches the row count
   * the user has to work through.
   */
  readonly needsAttention: number
  readonly nextRunAt?: number
  /** Multi-line status-bar tooltip; empty when there is nothing to say. */
  readonly tooltip: string
}

/** Status-bar summary: counts plus the tooltip, computed from one snapshot. */
export function summarizeTriggerCounts(
  list: readonly TriggerSummary[],
  now = Date.now(),
): TriggerCountSummary {
  const running = list.reduce((total, summary) => total + summary.running, 0)
  const needsConfirmation = list.filter(triggerNeedsConfirmation).length
  const autoPaused = list.filter((summary) => summary.autoPaused).length
  const offline = list.filter((summary) => summary.offline === true).length
  const errors = list.filter(
    (summary) =>
      summary.status !== 'invalid' &&
      summary.lastError !== undefined &&
      summary.lastError.length > 0,
  ).length
  const needsAttention = list.filter(triggerNeedsAttention).length
  let nextRunAt: number | undefined
  for (const summary of list) {
    if (summary.nextRunAt === undefined) continue
    nextRunAt = nextRunAt === undefined ? summary.nextRunAt : Math.min(nextRunAt, summary.nextRunAt)
  }

  if (list.length === 0) {
    return {
      total: 0,
      running: 0,
      needsConfirmation: 0,
      autoPaused: 0,
      offline: 0,
      errors: 0,
      needsAttention: 0,
      tooltip: localize(
        'trigger.manager.status.tooltip.empty',
        'No triggers. Click to open the trigger manager to create one.',
      ),
    }
  }

  const parts: string[] = []
  if (running > 0) {
    parts.push(localize('trigger.manager.counts.running', '{count} running', { count: running }))
  }
  if (needsConfirmation > 0) {
    parts.push(
      localize('trigger.manager.counts.needsConfirmation', '{count} needs confirmation', {
        count: needsConfirmation,
      }),
    )
  }
  if (autoPaused > 0) {
    parts.push(
      localize('trigger.manager.counts.autoPaused', '{count} auto-paused', { count: autoPaused }),
    )
  }
  if (offline > 0) {
    parts.push(localize('trigger.manager.counts.offline', '{count} offline', { count: offline }))
  }
  if (errors > 0) {
    parts.push(localize('trigger.manager.counts.errors', '{count} error', { count: errors }))
  }
  const headline = localize('trigger.manager.status.tooltip.total', 'Triggers: {total} total', {
    total: list.length,
  })
  const lines = [parts.length === 0 ? headline : `${headline} · ${parts.join(' · ')}`]
  if (nextRunAt !== undefined) {
    lines.push(
      localize('trigger.manager.status.tooltip.nextRun', 'Next run {when}', {
        when: relativeTimeUntil(nextRunAt, now),
      }),
    )
  }
  lines.push(
    '',
    localize('trigger.manager.status.tooltip.openManager', 'Click to open the trigger manager.'),
  )
  return {
    total: list.length,
    running,
    needsConfirmation,
    autoPaused,
    offline,
    errors,
    needsAttention,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    tooltip: lines.join('\n'),
  }
}

/** Relative time toward a future instant; the renderer never computes cron itself. */
export function relativeTimeUntil(target: number, now: number): string {
  const diff = target - now
  if (diff <= 0) return localize('trigger.manager.dueNow', 'due now')
  if (diff < 60_000) return localize('trigger.manager.inLessThanMinute', 'in <1m')
  if (diff < 3_600_000) {
    return localize('trigger.manager.inMinutes', 'in {count}m', {
      count: Math.floor(diff / 60_000),
    })
  }
  if (diff < 86_400_000) {
    return localize('trigger.manager.inHours', 'in {count}h', {
      count: Math.floor(diff / 3_600_000),
    })
  }
  return localize('trigger.manager.inDays', 'in {count}d', {
    count: Math.floor(diff / 86_400_000),
  })
}

export function formatTriggerDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) {
    return localize('trigger.manager.durationSeconds', '{seconds}s', { seconds })
  }
  const minutes = Math.floor(seconds / 60)
  return localize('trigger.manager.durationMinutes', '{minutes}m {seconds}s', {
    minutes,
    seconds: seconds % 60,
  })
}
