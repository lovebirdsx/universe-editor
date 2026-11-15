/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure QuickPick item builders for the Triggers commands: the trigger list and
 *  the per-trigger action menu. Kept free of DI so the formatting rules (status /
 *  source labels, run counts, last / next run, errors, high-privilege marker) are
 *  unit-testable without a service container.
 *--------------------------------------------------------------------------------------------*/

import { localize, type IQuickPickItem } from '@universe-editor/platform'
import { workspaceDisplayPath } from '../../shared/triggers/configParse.js'
import {
  triggerNeedsConfirmation,
  triggerSourceLabel,
  triggerStatusLabel,
} from '../services/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../shared/triggers/types.js'
import { relativeTime } from '../relativeTime.js'

export { triggerSourceLabel, triggerStatusLabel }

function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface TriggerPickItem extends IQuickPickItem {
  /** Composite workspace + trigger id; ids collide across workspaces. */
  readonly triggerKey: string
}

export function buildTriggerPickItems(summaries: readonly TriggerSummary[]): TriggerPickItem[] {
  return summaries.map((summary) => {
    const needsActivation = triggerNeedsConfirmation(summary)
    // The workspace path leads the description: two workspaces may define the same
    // trigger id, and the QuickPick must make them distinguishable. The summary
    // carries a workspace URI string; users see its friendly path.
    const description = [
      workspaceDisplayPath(summary.workspace),
      triggerStatusLabel(summary.status),
      triggerSourceLabel(summary.sourceType),
    ]
    if (summary.offline === true) {
      description.push(localize('triggers.item.offline', 'Remote host not connected'))
    }
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
    if (summary.offline === true) {
      detail.push(
        localize(
          'triggers.item.offlineDetail',
          'The remote host is disconnected. This trigger resumes automatically after you reconnect; missed events are handled per the trigger source.',
        ),
      )
    }
    if (needsActivation) {
      detail.push(
        localize(
          'triggers.item.needsActivation',
          'Awaiting confirmation: this trigger comes from the workspace configuration and will not run until you confirm it on this machine.',
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
      id: summary.key,
      triggerKey: summary.key,
      label: summary.elevatedMode ? `⚠ ${summary.name}` : summary.name,
      description: description.join(' · '),
      ...(detail.length > 0 ? { detail: detail.join('\n') } : {}),
    }
  })
}

export type TriggerItemAction =
  | 'openManager'
  | 'runNow'
  | 'pause'
  | 'resume'
  | 'confirmActivation'
  | 'openConfig'
  | 'showLog'

export interface TriggerActionPickItem extends IQuickPickItem {
  readonly action: TriggerItemAction
}

export function buildTriggerActionItems(summary: TriggerSummary): TriggerActionPickItem[] {
  const items: TriggerActionPickItem[] = [
    {
      id: 'openManager',
      action: 'openManager',
      label: localize('triggers.action.openManager', 'Open trigger manager'),
    },
  ]
  if (summary.status !== 'invalid') {
    items.push({
      id: 'runNow',
      action: 'runNow',
      label: localize('triggers.action.runNow', 'Run now'),
    })
  }
  if (triggerNeedsConfirmation(summary)) {
    items.push({
      id: 'confirmActivation',
      action: 'confirmActivation',
      label: localize('triggers.action.confirmActivation', 'Confirm workspace trigger…'),
    })
  }
  items.push(
    summary.paused
      ? { id: 'resume', action: 'resume', label: localize('triggers.action.resume', 'Resume') }
      : { id: 'pause', action: 'pause', label: localize('triggers.action.pause', 'Pause') },
  )
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

export type TriggerPickerAction = 'pause' | 'resume' | 'confirmActivation'

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
    case 'confirmActivation':
      return summaries.filter((summary) => triggerNeedsConfirmation(summary))
  }
}
