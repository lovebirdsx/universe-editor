/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI Fix dedicated-parameter helpers. The "Fix with AI" quick fix lets the
 *  user pin a dedicated agent / model / thinking depth / mode (the four
 *  `acp.aiFix.*` settings) that is fully isolated from the ordinary chat
 *  defaults. These pure functions read the settings bag and resolve it
 *  against the agent's last-known configOptions bag into wire-level
 *  configId → value overrides.
 *
 *  ConfigIds are NOT stable across agents (codex: `model`/`reasoning_effort`,
 *  claude: `model`/`effort`), so resolution keys on the stable `category`
 *  (`model` / `thought_level` / `mode`) and never hardcodes an id.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService, localize } from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { selectOptionHasValue } from './configOptionLabel.js'

export interface AiFixSettings {
  readonly agentId: string
  readonly model: string
  readonly thoughtLevel: string
  readonly mode: string
}

export const AI_FIX_AGENT_ID_KEY = 'acp.aiFix.agentId'
export const AI_FIX_MODEL_KEY = 'acp.aiFix.model'
export const AI_FIX_THOUGHT_LEVEL_KEY = 'acp.aiFix.thoughtLevel'
export const AI_FIX_MODE_KEY = 'acp.aiFix.mode'

export function readAiFixSettings(config: IConfigurationService): AiFixSettings {
  return {
    agentId: config.get<string>(AI_FIX_AGENT_ID_KEY) ?? 'codex',
    model: config.get<string>(AI_FIX_MODEL_KEY) ?? '',
    thoughtLevel: config.get<string>(AI_FIX_THOUGHT_LEVEL_KEY) ?? 'low',
    mode: config.get<string>(AI_FIX_MODE_KEY) ?? '',
  }
}

/** Category → which setting value applies. Shared so an empty bag can warn once per category. */
const CATEGORY_OF_SETTING: ReadonlyArray<{
  readonly category: 'model' | 'thought_level' | 'mode'
  readonly read: (s: AiFixSettings) => string
}> = [
  { category: 'model', read: (s) => s.model },
  { category: 'thought_level', read: (s) => s.thoughtLevel },
  { category: 'mode', read: (s) => s.mode },
]

/**
 * Resolve the settings bag into wire-level configId → value overrides for a
 * dedicated AI Fix session. Empty-string settings produce no override (the
 * value follows the per-agent default). Each non-empty value is validated
 * against the option's offered candidates (`selectOptionHasValue`); an
 * unselectable value is skipped with a warning so the bar never shows an
 * unoffered entry. An empty bag (agent never opened a session here) yields no
 * overrides plus a single warning — the state machine's reconcile is the
 * second line of defence once the authoritative bag lands.
 */
export function buildAiFixConfigOverrides(
  bag: readonly SessionConfigOption[],
  settings: AiFixSettings,
  onWarn: (msg: string) => void,
): Record<string, string> {
  const overrides: Record<string, string> = {}
  const wanted = CATEGORY_OF_SETTING.filter(({ read }) => read(settings) !== '')
  if (wanted.length === 0) return overrides
  if (bag.length === 0) {
    onWarn(
      localize(
        'acp.aiFix.noCachedOptions',
        'AI Fix: no cached config options for this agent yet — open one session with it first so the dedicated model/thinking depth can be applied. Using agent defaults for now.',
      ),
    )
    return overrides
  }
  for (const { category, read } of wanted) {
    const value = read(settings)
    const opt = bag.find((o) => o.type === 'select' && o.category === category)
    if (!opt || opt.type !== 'select') {
      onWarn(
        localize(
          'acp.aiFix.optionMissing',
          'AI Fix: the agent offers no {category} option, so the configured value "{value}" was ignored.',
          { category, value },
        ),
      )
      continue
    }
    if (!selectOptionHasValue(opt, value)) {
      onWarn(
        localize(
          'acp.aiFix.valueInvalid',
          'AI Fix: "{value}" is not a selectable {category} for this agent — ignored.',
          { value, category },
        ),
      )
      continue
    }
    overrides[opt.id] = value
  }
  return overrides
}
