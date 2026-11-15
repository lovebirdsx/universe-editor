/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Form draft model shared by the configuration panel and the create wizard.
 *  Drafts keep numeric inputs as strings so a half-typed value is never
 *  silently coerced. Source-specific fields live in a discriminated `source`
 *  draft owned by the descriptor registry; the raw object built here goes
 *  through the same `parseTriggersConfig` the scheduler uses, which is what
 *  produces every validation message shown in the UI.
 *--------------------------------------------------------------------------------------------*/

import { parseTriggersConfig, triggerConfigError } from '../../../shared/triggers/configParse.js'
import {
  TRIGGER_DEFAULTS,
  type TriggerConfig,
  type TriggerConfigError,
  type TriggerOverflow,
  type TriggerSourceType,
} from '../../../shared/triggers/types.js'
import { triggerSourceDescriptor } from './triggerSources/index.js'
import type { TriggerSourceDraft, TriggerSourceDraftPatch } from './triggerSources/types.js'

export interface TriggerConfigDraft {
  readonly name: string
  readonly enabled: boolean
  readonly showSession: boolean
  readonly concurrency: string
  readonly overflow: TriggerOverflow
  readonly source: TriggerSourceDraft
  readonly agent: string
  readonly mode: string
  readonly model: string
  readonly cwd: string
  readonly skill: string
  readonly prompt: string
  readonly maxCostUsd: string
  readonly timeoutMin: string
  readonly approvalTimeoutMin: string
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

export function toDraftNumber(value: string): number {
  const trimmed = value.trim()
  return trimmed.length === 0 ? Number.NaN : Number(trimmed)
}

export function draftFromConfig(config: TriggerConfig): TriggerConfigDraft {
  return {
    name: config.name,
    enabled: config.enabled,
    showSession: config.showSession,
    concurrency: String(config.concurrency),
    overflow: config.overflow,
    source: triggerSourceDescriptor(config.source.type).fromConfig(config.source),
    agent: config.session.agent ?? '',
    mode: config.session.mode ?? '',
    model: config.session.model ?? '',
    cwd: config.session.cwd ?? '',
    skill: config.session.skill ?? '',
    prompt: config.session.prompt,
    maxCostUsd: numberText(config.session.budget.maxCostUsd),
    timeoutMin: String(config.session.budget.timeoutMin),
    approvalTimeoutMin: String(config.session.budget.approvalTimeoutMin),
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
    source: triggerSourceDescriptor('manual').empty(),
    agent: '',
    mode: '',
    model: '',
    cwd: '',
    skill: '',
    prompt: '',
    maxCostUsd: numberText(TRIGGER_DEFAULTS.budget.maxCostUsd),
    timeoutMin: String(TRIGGER_DEFAULTS.budget.timeoutMin),
    approvalTimeoutMin: String(TRIGGER_DEFAULTS.budget.approvalTimeoutMin),
  }
}

/**
 * Switch the source type: the new descriptor starts from its own defaults.
 * Source parameter edits outside the `type` switch never cross descriptors.
 */
export function withSourceType(
  draft: TriggerConfigDraft,
  type: TriggerSourceType,
): TriggerConfigDraft {
  return { ...draft, source: triggerSourceDescriptor(type).empty() }
}

export function withSourcePatch(
  draft: TriggerConfigDraft,
  patch: TriggerSourceDraftPatch,
): TriggerConfigDraft {
  const { type: _type, ...fields } = patch
  return {
    ...draft,
    source: { ...draft.source, ...fields } as TriggerSourceDraft,
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
    source: triggerSourceDescriptor(draft.source.type).build(draft.source),
    session: buildSession(draft),
    concurrency: toDraftNumber(draft.concurrency),
    overflow: draft.overflow,
  }
}

export interface TriggerDraftValidation {
  readonly config: TriggerConfig | undefined
  /** Readable messages (English); UI surfaces use `issues` for localization. */
  readonly errors: readonly string[]
  readonly issues: readonly TriggerConfigError[]
}

export function validateTriggerDraft(
  id: string,
  draft: TriggerConfigDraft,
): TriggerDraftValidation {
  const parsed = parseTriggersConfig({ version: 1, triggers: [buildRawTrigger(id, draft)] })
  if (!parsed.ok) {
    return { config: undefined, errors: [parsed.error], issues: [parsed.issue] }
  }
  const invalid = parsed.config.invalid.find((entry) => entry.id === id)
  if (invalid !== undefined) {
    return { config: undefined, errors: invalid.errors, issues: invalid.issues }
  }
  const config = parsed.config.triggers.find((entry) => entry.id === id)
  return config === undefined
    ? {
        config: undefined,
        errors: ['the trigger could not be parsed'],
        issues: [triggerConfigError([], 'trigger.notObject', 'the trigger could not be parsed')],
      }
    : { config, errors: [], issues: [] }
}
