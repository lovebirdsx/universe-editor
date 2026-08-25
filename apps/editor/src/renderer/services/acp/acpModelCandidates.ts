/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers deciding which model ids the editor hands an agent fork as extra
 *  session-level candidates (`_meta.extraModels`).
 *
 *  Why this exists: an agent fork builds its Model picker from its own vendor
 *  catalogue — the Claude SDK's hardcoded Anthropic list, or codex's app-server
 *  `model/list`. A gateway model (`deepseek-pro-v4`) is never in there, and both
 *  forks REJECT a `set_config_option` value that is not among the advertised
 *  options. So a gateway user cannot switch models inside a session at all.
 *
 *  The editor already knows the answer: `aiSettings.json`'s `providers[].protocolMap`
 *  declares exactly which models the selected gateway serves under the agent's
 *  protocol. These helpers turn that declaration into the id list injected at
 *  handshake time; the forks append it to their catalogue, which lights up both
 *  the picker and the switch validation.
 *--------------------------------------------------------------------------------------------*/

import type { AiResolvedProvider, AiWireProtocol } from '@universe-editor/platform'
import { withOneM } from './modelOneM.js'

/** Wire protocol each built-in agent speaks, i.e. which `protocolMap` entry holds its models. */
export const CLAUDE_AGENT_PROTOCOL: AiWireProtocol = 'anthropic-messages'
export const CODEX_AGENT_PROTOCOL: AiWireProtocol = 'openai-responses'

/**
 * Upper bound on injected candidates. A `_meta` payload travels on every
 * session/new + session/load + reconnect, so an accidentally huge `protocolMap`
 * (or a discover-style gateway listing hundreds of models) must not bloat the
 * handshake. 64 is far above any hand-curated gateway list.
 */
export const MAX_EXTRA_MODELS = 64

/**
 * Model candidates a resolved provider declares under one protocol. Mirrors the
 * AI-settings dropdown: a `discover` protocol (declared `[]`) contributes
 * nothing, because availability then comes from the endpoint rather than the
 * file and we have no list to forward.
 */
export function candidateModelsForProtocol(
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly string[] {
  const p = provider?.protocols.find((pr) => pr.protocol === protocol)
  if (p === undefined || p.discover || p.models.length === 0) return []
  return p.models.map((m) => m.channelModel)
}

/** The editor's model pick for an agent, as a bare id plus its optional `[1m]` lane. */
export interface ModelPickSpelling {
  readonly model?: string
  readonly oneM?: boolean
}

/**
 * The full candidate list for one agent: every model the selected provider
 * declares, plus the user's own pick in BOTH spellings.
 *
 * The effective spelling (`deepseek-pro-v4[1m]`) is not optional garnish. The
 * claude fork resolves `settings.model` against its catalogue with a fuzzy
 * tokenized fallback that happily matches `foo[1m]` to a bare `foo` entry —
 * silently dropping the 1M lane and clamping the window back to 200k. Carrying
 * the verbatim spelling lets the fork's exact-match layer win instead.
 *
 * The bare pick is kept too: the user may have switched providers since, and a
 * stale pick that is not offered anymore must still be selectable (same reason
 * the settings dropdown pins an unlisted current value).
 */
export function extraModelsForAgentSettings(
  pick: ModelPickSpelling,
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (id: string | undefined): void => {
    const trimmed = id?.trim()
    if (!trimmed || seen.has(trimmed) || out.length >= MAX_EXTRA_MODELS) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  // The user's own pick first — it is the one value that must survive truncation.
  const bare = pick.model?.trim()
  if (bare) {
    add(withOneM(bare, pick.oneM === true))
    add(bare)
  }
  for (const m of candidateModelsForProtocol(provider, protocol)) add(m)
  return out
}
