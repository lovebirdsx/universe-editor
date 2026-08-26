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
  return p.models.map((m) => candidate(m.channelModel, m.knowledge.maxInputTokens))
}

/** Model ids a resolved provider declares under one protocol (id-only projection). */
export function candidateModelsForProtocol(
  provider: AiResolvedProvider | undefined,
  protocol: AiWireProtocol,
): readonly string[] {
  return candidateModelCandidatesForProtocol(provider, protocol).map((c) => c.id)
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
    const trimmed = c.id.trim()
    if (!trimmed || seen.has(trimmed) || out.length >= MAX_EXTRA_MODELS) return
    seen.add(trimmed)
    out.push(candidate(trimmed, c.contextWindow))
  }

  const trimmedPick = pick?.trim()
  if (trimmedPick) {
    const declaredPick = declared.find((c) => c.id === trimmedPick)
    add(declaredPick ?? candidate(trimmedPick, undefined))
  }
  for (const c of declared) add(c)
  return out
}

/**
 * The declared window of exactly the model named by `modelId`, and nothing else:
 * NEVER hand codex one model's window for another. Anything we cannot resolve
 * precisely — an unnamed model, or a name absent from the candidates — yields
 * undefined, which leaves codex on its own documented fallback.
 *
 * Both unresolvable cases are real and would silently mismanage the context
 * (auto-compaction firing at half the true window, or prompts overflowing past
 * it) if we guessed. A remembered model of an older session commonly isn't among
 * the current candidates because the user has since switched providers. And an
 * unnamed model means the agent's config file declares no pick, so it runs its
 * own default — `candidates[0]` is then merely the provider's first declared
 * model, related to that default by nothing at all.
 */
export function contextWindowFor(
  candidates: readonly AcpModelCandidate[],
  modelId: string | undefined,
): number | undefined {
  const trimmed = modelId?.trim()
  if (!trimmed) return undefined
  return candidates.find((c) => c.id === trimmed)?.contextWindow
}

function candidate(id: string, contextWindow: number | undefined): AcpModelCandidate {
  return contextWindow !== undefined ? { id, contextWindow } : { id }
}
