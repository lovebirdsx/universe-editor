/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Form draft model shared by the configuration panel and the create wizard.
 *  Drafts keep numeric inputs as strings so a half-typed value is never
 *  silently coerced; the raw object built here goes through the same
 *  `parseTriggersConfig` the scheduler uses, which is what produces every
 *  validation message shown in the UI.
 *--------------------------------------------------------------------------------------------*/

import { parseTriggersConfig } from '../../../shared/triggers/configParse.js'
import {
  TRIGGER_DEFAULTS,
  type TriggerActionType,
  type TriggerConfig,
  type TriggerOnMissed,
  type TriggerOverflow,
} from '../../../shared/triggers/types.js'

export type TriggerSourceType = TriggerConfig['source']['type']

export interface TriggerConfigDraft {
  readonly name: string
  readonly enabled: boolean
  readonly showSession: boolean
  readonly concurrency: string
  readonly overflow: TriggerOverflow
  readonly sourceType: TriggerSourceType
  readonly cron: string
  readonly everyMin: string
  readonly onMissed: TriggerOnMissed
  readonly intervalSec: string
  readonly command: string
  readonly pollTimeoutSec: string
  readonly keyField: string
  readonly agent: string
  readonly mode: string
  readonly model: string
  readonly cwd: string
  readonly skill: string
  readonly prompt: string
  readonly maxCostUsd: string
  readonly timeoutMin: string
  readonly approvalTimeoutMin: string
  readonly allowedActions: readonly TriggerActionType[]
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

export function toDraftNumber(value: string): number {
  const trimmed = value.trim()
  return trimmed.length === 0 ? Number.NaN : Number(trimmed)
}

export function draftFromConfig(config: TriggerConfig): TriggerConfigDraft {
  const source = config.source
  const schedule = source.type === 'schedule' ? source : undefined
  const poll = source.type === 'poll' ? source : undefined
  return {
    name: config.name,
    enabled: config.enabled,
    showSession: config.showSession,
    concurrency: String(config.concurrency),
    overflow: config.overflow,
    sourceType: source.type,
    cron: schedule?.cron ?? '',
    everyMin: schedule?.everyMin === undefined ? '' : String(schedule.everyMin),
    onMissed: schedule?.onMissed ?? 'skip',
    intervalSec: poll === undefined ? '600' : String(poll.intervalSec),
    command: poll?.fetch.command ?? '',
    pollTimeoutSec: String(poll?.fetch.timeoutSec ?? TRIGGER_DEFAULTS.pollTimeoutSec),
    keyField: poll?.keyField ?? 'id',
    agent: config.session.agent ?? '',
    mode: config.session.mode ?? '',
    model: config.session.model ?? '',
    cwd: config.session.cwd ?? '',
    skill: config.session.skill ?? '',
    prompt: config.session.prompt,
    maxCostUsd: numberText(config.session.budget.maxCostUsd),
    timeoutMin: String(config.session.budget.timeoutMin),
    approvalTimeoutMin: String(config.session.budget.approvalTimeoutMin),
    allowedActions: config.allowedActions,
  }
}

export function emptyDraft(): TriggerConfigDraft {
  return {
    name: '',
    // New triggers start paused on the machine that first sees them; `enabled`
    // still defaults to true so resuming is the only step left.
    enabled: true,
    showSession: false,
    concurrency: String(TRIGGER_DEFAULTS.concurrency),
    overflow: TRIGGER_DEFAULTS.overflow,
    sourceType: 'manual',
    cron: '',
    everyMin: '',
    onMissed: 'skip',
    intervalSec: '600',
    command: '',
    pollTimeoutSec: String(TRIGGER_DEFAULTS.pollTimeoutSec),
    keyField: 'id',
    agent: '',
    mode: '',
    model: '',
    cwd: '',
    skill: '',
    prompt: '',
    maxCostUsd: numberText(TRIGGER_DEFAULTS.budget.maxCostUsd),
    timeoutMin: String(TRIGGER_DEFAULTS.budget.timeoutMin),
    approvalTimeoutMin: String(TRIGGER_DEFAULTS.budget.approvalTimeoutMin),
    allowedActions: [],
  }
}

function buildSource(draft: TriggerConfigDraft): unknown {
  switch (draft.sourceType) {
    case 'manual':
      return { type: 'manual' }
    case 'swarm-review':
      return { type: 'swarm-review' }
    case 'schedule':
      return draft.cron.trim().length > 0
        ? { type: 'schedule', cron: draft.cron, onMissed: draft.onMissed }
        : { type: 'schedule', everyMin: toDraftNumber(draft.everyMin), onMissed: draft.onMissed }
    case 'poll':
      return {
        type: 'poll',
        intervalSec: toDraftNumber(draft.intervalSec),
        fetch: {
          type: 'command',
          command: draft.command,
          timeoutSec: toDraftNumber(draft.pollTimeoutSec),
        },
        keyField: draft.keyField,
      }
  }
}

function buildSession(draft: TriggerConfigDraft): Record<string, unknown> {
  const session: Record<string, unknown> = {
    prompt: draft.prompt,
    budget: {
      maxCostUsd: draft.maxCostUsd.trim().length === 0 ? null : toDraftNumber(draft.maxCostUsd),
      timeoutMin: toDraftNumber(draft.timeoutMin),
      approvalTimeoutMin: toDraftNumber(draft.approvalTimeoutMin),
    },
  }
  if (draft.agent.trim().length > 0) session['agent'] = draft.agent
  if (draft.mode.trim().length > 0) session['mode'] = draft.mode
  if (draft.model.trim().length > 0) session['model'] = draft.model
  if (draft.cwd.trim().length > 0) session['cwd'] = draft.cwd
  if (draft.skill.trim().length > 0) session['skill'] = draft.skill
  return session
}

export function buildRawTrigger(id: string, draft: TriggerConfigDraft): Record<string, unknown> {
  return {
    id,
    name: draft.name,
    enabled: draft.enabled,
    showSession: draft.showSession,
    source: buildSource(draft),
    session: buildSession(draft),
    allowedActions: draft.allowedActions,
    concurrency: toDraftNumber(draft.concurrency),
    overflow: draft.overflow,
  }
}

export interface TriggerDraftValidation {
  readonly config: TriggerConfig | undefined
  readonly errors: readonly string[]
}

export function validateTriggerDraft(
  id: string,
  draft: TriggerConfigDraft,
): TriggerDraftValidation {
  const parsed = parseTriggersConfig({ version: 1, triggers: [buildRawTrigger(id, draft)] })
  if (!parsed.ok) return { config: undefined, errors: [parsed.error] }
  const invalid = parsed.config.invalid.find((entry) => entry.id === id)
  if (invalid !== undefined) return { config: undefined, errors: invalid.errors }
  const config = parsed.config.triggers.find((entry) => entry.id === id)
  return config === undefined
    ? { config: undefined, errors: ['the trigger could not be parsed'] }
    : { config, errors: [] }
}
