/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure QuickPick item builders for the Triggers commands: the trigger list and
 *  the per-trigger action menu. Kept free of DI so the formatting rules (status /
 *  source labels, run counts, last / next run, errors, high-privilege marker) are
 *  unit-testable without a service container.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IQuickPickItem } from '@universe-editor/platform'
import type {
  TriggerSourceType,
  TriggerStatus,
  TriggerSummary,
} from '../../shared/triggers/types.js'
import { relativeTime } from '../relativeTime.js'

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
    case 'swarm-review':
      return localize('triggers.source.swarmReview', 'Swarm review')
    case 'unknown':
      return localize('triggers.source.unknown', 'Unknown source')
  }
}

function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface TriggerPickItem extends IQuickPickItem {
  readonly triggerId: string
}

export function buildTriggerPickItems(summaries: readonly TriggerSummary[]): TriggerPickItem[] {
  return summaries.map((summary) => {
    const unconfirmedElevated = summary.elevatedMode && !summary.elevatedModeConfirmed
    const description = [triggerStatusLabel(summary.status), triggerSourceLabel(summary.sourceType)]
    if (summary.running > 0) {
      description.push(
        localize('triggers.item.running', '{count} running', { count: summary.running }),
      )
    }
    if (summary.queued > 0) {
      description.push(
        localize('triggers.item.queued', '{count} queued', { count: summary.queued }),
      )
    }
    if (summary.lastRunAt !== undefined) {
      description.push(
        localize('triggers.item.lastRun', 'Last run {time}', {
          time: relativeTime(summary.lastRunAt),
        }),
      )
    }
    if (summary.nextRunAt !== undefined) {
      description.push(
        localize('triggers.item.nextRun', 'Next run at {time}', {
          time: clockTime(summary.nextRunAt),
        }),
      )
    }

    const detail: string[] = []
    if (unconfirmedElevated) {
      detail.push(
        localize(
          'triggers.item.elevatedUnconfirmed',
          '⚠ High-privilege mode is configured but not confirmed; this trigger will not run until you confirm it.',
        ),
      )
    }
    const errorText = [summary.lastError, ...(summary.errors ?? [])]
      .filter((entry): entry is string => entry !== undefined && entry.length > 0)
      .join(' · ')
    if (errorText.length > 0) {
      detail.push(localize('triggers.item.error', 'Error: {error}', { error: errorText }))
    }

    return {
      id: summary.id,
      triggerId: summary.id,
      label: summary.elevatedMode ? `⚠ ${summary.name}` : summary.name,
      description: description.join(' · '),
      ...(detail.length > 0 ? { detail: detail.join('\n') } : {}),
    }
  })
}

export type TriggerItemAction =
  | 'runNow'
  | 'pause'
  | 'resume'
  | 'confirmElevatedMode'
  | 'confirmAutoApprove'
  | 'openConfig'
  | 'showLog'

export interface TriggerActionPickItem extends IQuickPickItem {
  readonly action: TriggerItemAction
}

export function buildTriggerActionItems(summary: TriggerSummary): TriggerActionPickItem[] {
  const items: TriggerActionPickItem[] = []
  if (summary.status !== 'invalid') {
    items.push({
      id: 'runNow',
      action: 'runNow',
      label: localize('triggers.action.runNow', 'Run now'),
    })
  }
  items.push(
    summary.paused
      ? { id: 'resume', action: 'resume', label: localize('triggers.action.resume', 'Resume') }
      : { id: 'pause', action: 'pause', label: localize('triggers.action.pause', 'Pause') },
  )
  if (summary.elevatedMode && !summary.elevatedModeConfirmed) {
    items.push({
      id: 'confirmElevatedMode',
      action: 'confirmElevatedMode',
      label: localize('triggers.action.confirmElevatedMode', 'Confirm high-privilege mode…'),
    })
  }
  if (summary.approveAction && !summary.approveConfirmed) {
    items.push({
      id: 'confirmAutoApprove',
      action: 'confirmAutoApprove',
      label: localize('triggers.action.confirmAutoApprove', 'Confirm automatic approve…'),
    })
  }
  items.push({
    id: 'openConfig',
    action: 'openConfig',
    label: localize('triggers.action.openConfig', 'Open configuration'),
  })
  items.push({
    id: 'showLog',
    action: 'showLog',
    label: localize('triggers.action.showLog', 'Show log'),
  })
  return items
}

export type TriggerPickerAction = 'pause' | 'resume' | 'confirmElevatedMode' | 'confirmAutoApprove'

/** Candidates for a command that needs the user to pick a trigger first. */
export function triggersForAction(
  action: TriggerPickerAction,
  summaries: readonly TriggerSummary[],
): readonly TriggerSummary[] {
  switch (action) {
    case 'pause':
      return summaries.filter((summary) => !summary.paused)
    case 'resume':
      return summaries.filter((summary) => summary.paused)
    case 'confirmElevatedMode':
      return summaries.filter((summary) => summary.elevatedMode && !summary.elevatedModeConfirmed)
    case 'confirmAutoApprove':
      return summaries.filter((summary) => summary.approveAction && !summary.approveConfirmed)
  }
}
