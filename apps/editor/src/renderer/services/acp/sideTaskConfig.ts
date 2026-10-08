/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Side-task default-model helpers. A side task forks the parent session's whole
 *  config-option bag, so its model follows whatever the parent is running —
 *  `acp.sideTask.models` lets the user pin the model a NEW side task starts on.
 *  The map is keyed by agent id because the agent comes from the parent session
 *  (not from a fixed setting), and model values are per-agent anyway.
 *
 *  These pure functions read that map and resolve it against the parent's live
 *  bag into wire-level configId → value overrides. ConfigIds are NOT stable
 *  across agents, so resolution keys on the stable `category` and never
 *  hardcodes an id. A pin the agent does not offer is skipped with a warning:
 *  the side task then inherits the parent's model, so a stale pin never blocks
 *  a fork.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService, localize } from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  findConfigOptionLabel,
  findSelectOptionByCategory,
  selectOptionHasValue,
} from './configOptionLabel.js'

export interface SideTaskModelOverrides {
  /** configId → value, for the fork's desired-config seed and its history row. */
  readonly values: Readonly<Record<string, string>>
  /** configId → friendly display name, so a row shows the model before the load lands. */
  readonly labels: Readonly<Record<string, string>>
  /** The pinned model, for the fork's context-window meta. */
  readonly model?: { readonly configId: string; readonly value: string }
}

export const SIDE_TASK_MODELS_KEY = 'acp.sideTask.models'

const EMPTY_MODELS: Readonly<Record<string, string>> = Object.freeze({})
const NO_OVERRIDES: SideTaskModelOverrides = Object.freeze({ values: {}, labels: {} })

/**
 * The per-agent model pins. Hand-edited settings.json can hold anything — a bad
 * entry is dropped here rather than breaking every fork.
 */
export function readSideTaskModels(
  config: IConfigurationService,
): Readonly<Record<string, string>> {
  const raw = config.get<Record<string, unknown>>(SIDE_TASK_MODELS_KEY)
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return EMPTY_MODELS
  }
  const out: Record<string, string> = {}
  for (const [agentId, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    out[agentId] = trimmed
  }
  return out
}

/**
 * Resolve the per-agent pin for `agentId` against the parent session's live bag
 * (that bag is the very option list the fork will advertise, so it validates the
 * value exactly). No entry for this agent — the common case — yields no
 * overrides and NO warning; an entry the agent does not offer is skipped with a
 * warning so the fork still runs on the inherited model.
 */
export function buildSideTaskModelOverrides(
  bag: readonly SessionConfigOption[],
  agentId: string,
  models: Readonly<Record<string, string>>,
  onWarn: (msg: string) => void,
): SideTaskModelOverrides {
  const value = models[agentId]
  if (value === undefined) return NO_OVERRIDES
  const opt = findSelectOptionByCategory(bag, 'model')
  if (!opt) {
    onWarn(
      localize(
        'acp.sideTask.noModelOption',
        'Side task: agent "{agentId}" offers no model switch, so the configured "{value}" was ignored — the side task inherits the parent model.',
        { agentId, value },
      ),
    )
    return NO_OVERRIDES
  }
  if (!selectOptionHasValue(opt, value)) {
    onWarn(
      localize(
        'acp.sideTask.modelInvalid',
        'Side task: "{value}" is not a selectable model for agent "{agentId}" — ignored, the side task inherits the parent model.',
        { value, agentId },
      ),
    )
    return NO_OVERRIDES
  }
  return {
    values: { [opt.id]: value },
    labels: { [opt.id]: findConfigOptionLabel(opt.options, value) },
    model: { configId: opt.id, value },
  }
}
