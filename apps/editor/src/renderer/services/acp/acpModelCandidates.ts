/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers deciding which model ids the editor hands an agent fork as extra
 *  session-level candidates (`_meta.extraModels`).
 *
 *  Why this exists: an agent fork builds its Model picker from its own vendor
 *  catalogue — the Claude SDK's hardcoded Anthropic list, or codex's app-server
 *  `model/list`. A gateway model (`acme-chat-pro`) is never in there, and both
 *  forks REJECT a `set_config_option` value that is not among the advertised
 *  options. So a gateway user cannot switch models inside a session at all.
 *
 *  The editor already knows the answer: `aiSettings.json`'s `providers[].protocolMap`
 *  declares exactly which models the selected gateway serves under the agent's
 *  protocol. These helpers turn that declaration into the id list injected at
 *  handshake time; the forks append it to their catalogue, which lights up both
 *  the picker and the switch validation.
 *--------------------------------------------------------------------------------------------*/

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type {
  AiModelKnowledge,
  AiResolvedProvider,
  AiWireProtocol,
} from '@universe-editor/platform'

import {
  normalizeAnthropicVersionDots,
  stripTrailingBracketSuffix,
} from '../../../shared/ai/catalog/index.js'

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
 * One candidate model the editor advertises to an agent fork. `contextWindow` is
 * the model's known input-token window (`knowledge.maxInputTokens`) when the AI
 * settings declare it, and undefined otherwise — codex uses it to override its
 * built-in fallback so a gateway model's context is managed correctly.
 */
export interface AcpModelCandidate {
  readonly id: string
  readonly contextWindow?: number
  readonly effortLevels?: readonly string[]
}

/**
 * Candidate models a resolved provider declares under one protocol, each with
 * its known context window. Mirrors the AI-settings dropdown: a `discover`
 * protocol (declared `[]`) contributes nothing, because availability then comes
 * from the endpoint rather than the file and we have no list to forward.
 */
export function candidateModelCandidatesForProtocol(
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly AcpModelCandidate[] {
  const p = provider?.protocols.find((pr) => pr.protocol === protocol)
  if (p === undefined || p.discover || p.models.length === 0) return []
  return p.models.map((m) =>
    candidate(m.channelModel, m.knowledge.maxInputTokens, m.knowledge.supportsReasoningEffort),
  )
}

/** Model ids a resolved provider declares under one protocol (id-only projection). */
export function candidateModelsForProtocol(
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly string[] {
  return candidateModelCandidatesForProtocol(provider, protocol).map((c) => c.id)
}

/**
 * Every value the session's live `model` select option offers — the fork's own
 * catalogue (the Claude SDK's official Anthropic list) merged with the
 * `extraModels` injected at handshake time, i.e. exactly what the main model
 * picker lets the user choose. Grouped option shapes are flattened to their
 * values. An empty result means the bag carries no usable model option (not yet
 * handshaked, or a non-select shape), so callers fall back to their own source.
 */
export function sessionModelCandidates(
  configOptions: readonly SessionConfigOption[],
): readonly string[] {
  const modelOption = configOptions.find((o) => o.category === 'model')
  if (modelOption?.type !== 'select') return []
  const out: string[] = []
  for (const o of modelOption.options) {
    if ('group' in o) {
      for (const v of o.options) out.push(v.value)
    } else {
      out.push(o.value)
    }
  }
  return out
}

/**
 * The model the session is currently set to run (`model` select's currentValue),
 * or `undefined` when the bag carries no usable model option (not yet
 * handshaked, or a non-select shape). Raw value: callers that bucket by model
 * normalize it themselves. Note this follows the user's intent rather than the
 * agent's confirmation — `ConfigOptionStateMachine` flips `currentValue`
 * optimistically, before the `set_config_option` round-trip settles.
 */
export function sessionModelId(configOptions: readonly SessionConfigOption[]): string | undefined {
  const modelOption = configOptions.find((o) => o.category === 'model')
  return modelOption?.type === 'select' ? modelOption.currentValue : undefined
}

/**
 * Merge candidate id lists in order, deduping on the normalized id and keeping
 * the first spelling that wins. Used to union the session's live model list with
 * the provider's `protocolMap` declaration: the session list already carries the
 * gateway models once handshaked, so the declaration only adds the pre-handshake
 * window (and the no-model-option fallback) without duplicating rows.
 */
export function mergeModelCandidates(...lists: readonly (readonly string[])[]): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const id of list) {
      const normalized = normalizeAnthropicVersionDots(id.trim())
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

/**
 * The full candidate list for one agent: the user's own model, then every model
 * the selected provider declares, each carrying its known context window.
 *
 * `pick` is the EFFECTIVE id from the agent's own config file (`settings.model` /
 * config.toml `model`) — the exact string the fork will resolve. Carrying it
 * verbatim is not optional garnish: the claude fork resolves the model against
 * its catalogue with a fuzzy tokenized fallback that happily matches `foo[1m]` to
 * a bare `foo` entry, silently dropping the 1M lane and clamping the window back
 * to 200k. An exact-match entry lets the fork's precise layer win instead.
 *
 * It also goes first so it survives truncation: the user may have switched
 * providers since, and a value the provider no longer offers must still be
 * selectable (same reason the settings dropdown pins an unlisted current value).
 * The pick's own window is resolved from the provider's declaration when present.
 */
export function extraModelCandidatesForAgentSettings(
  pick: string | undefined,
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly AcpModelCandidate[] {
  const declared = candidateModelCandidatesForProtocol(provider, protocol)
  const out: AcpModelCandidate[] = []
  const seen = new Set<string>()
  const add = (c: AcpModelCandidate): void => {
    // Dedupe on the normalized id: a gateway declaring the dotted form next to
    // the canonical hyphenated one must not inject the same model twice.
    const normalized = normalizeAnthropicVersionDots(c.id.trim())
    if (!normalized || seen.has(normalized) || out.length >= MAX_EXTRA_MODELS) return
    seen.add(normalized)
    out.push(candidate(normalized, c.contextWindow, c.effortLevels))
  }

  const trimmedPick = pick?.trim()
  if (trimmedPick) {
    const declaredPick =
      declared.find((c) => c.id === trimmedPick) ??
      declared.find(
        (c) => stripTrailingBracketSuffix(c.id) === stripTrailingBracketSuffix(trimmedPick),
      )
    // Keep the pick's verbatim id (its `[1m]` lane) while carrying the matched
    // bare entry's window + effort, so the fork's exact-match layer wins instead
    // of its fuzzy fallback shrinking the lane away.
    add(candidate(trimmedPick, declaredPick?.contextWindow, declaredPick?.effortLevels))
  }
  for (const c of declared) add(c)
  return out
}

/**
 * Project the user's own knowledge layer (`aiSettings.json` → `models`) to the
 * model-id → `maxInputTokens` table {@link contextWindowFor} consults. Only ids
 * that actually declare a window are carried — an entry declaring other
 * knowledge must not read as "window known".
 */
export function userDeclaredWindows(
  userKnowledge: Readonly<Record<string, AiModelKnowledge>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [id, knowledge] of Object.entries(userKnowledge)) {
    if (knowledge.maxInputTokens !== undefined) out[id] = knowledge.maxInputTokens
  }
  return out
}

/**
 * The declared window of exactly the model named by `modelId`, and nothing else:
 * NEVER hand codex one model's window for another. Anything we cannot resolve
 * precisely — an unnamed model, or a name that neither the candidates nor the
 * user's declarations carry — yields undefined, which leaves codex on its own
 * documented fallback.
 *
 * Both unresolvable cases are real and would silently mismanage the context
 * (auto-compaction firing at half the true window, or prompts overflowing past
 * it) if we guessed. A remembered model of an older session commonly isn't among
 * the current candidates because the user has since switched providers. And an
 * unnamed model means the agent's config file declares no pick, so it runs its
 * own default — `candidates[0]` is then merely the provider's first declared
 * model, related to that default by nothing at all.
 *
 * `declaredWindows` is the user's own `models` layer (`aiSettings.json`),
 * consulted by the exact name asked about — including a remembered model that is
 * not a candidate at all. A subscription session has no provider entry to carry
 * a window, yet the "context window unknown" warning tells the user to declare
 * `maxInputTokens`; that declaration must actually be read back. It is a name
 * match against the user's own entry, never a guess.
 */
export function contextWindowFor(
  candidates: readonly AcpModelCandidate[],
  modelId: string | undefined,
  declaredWindows?: Readonly<Record<string, number>>,
): number | undefined {
  const trimmed = modelId?.trim()
  if (!trimmed) return undefined
  // Candidates carry the normalized id, so a remembered/configured model spelled
  // dotted (`claude-opus-4.8`) must be normalized too or the lookup misses.
  const query = normalizeAnthropicVersionDots(trimmed)
  const exact = candidates.find((c) => c.id === query)
  if (exact?.contextWindow !== undefined) return exact.contextWindow
  // A remembered id may carry a context-lane suffix (`acme-chat-pro[1m]`) that
  // the provider's declaration spells bare; match on the stripped name.
  const byBareName = candidates.find(
    (c) => stripTrailingBracketSuffix(c.id) === stripTrailingBracketSuffix(query),
  )?.contextWindow
  if (byBareName !== undefined) return byBareName
  return declaredWindows === undefined ? undefined : declaredWindowFor(declaredWindows, query)
}

/**
 * Name match against {@link userDeclaredWindows}: exact spelling first, then the
 * lane-stripped name — the same two spellings {@link contextWindowFor} accepts
 * from candidates.
 */
function declaredWindowFor(
  declaredWindows: Readonly<Record<string, number>>,
  query: string,
): number | undefined {
  const exact = declaredWindows[query]
  if (exact !== undefined) return exact
  const bare = stripTrailingBracketSuffix(query)
  for (const [id, window] of Object.entries(declaredWindows)) {
    if (stripTrailingBracketSuffix(id) === bare) return window
  }
  return undefined
}

function candidate(
  id: string,
  contextWindow: number | undefined,
  effortLevels?: readonly string[],
): AcpModelCandidate {
  return {
    id: normalizeAnthropicVersionDots(id),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(effortLevels !== undefined ? { effortLevels } : {}),
  }
}
