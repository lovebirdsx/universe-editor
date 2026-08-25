/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse lookup: which credential is actually in effect for a built-in agent on
 *  a given host, derived from that agent's own config files. The agent's config is
 *  the single source of truth — the editor keeps no declared mirror, so there is
 *  no drift to detect and no `@subscription` sentinel on this side.
 *
 *  Each resolver forward-derives the credential shape of every provider entry
 *  (`providerDerivation.ts` — the same code the panel writes with) and compares it
 *  byte-for-byte against what is on disk. Base URLs are compared verbatim, with no
 *  URL normalization: the on-disk value was written from the entry, so normalizing
 *  can only manufacture false mismatches.
 *
 *  Ambiguity is resolved by deterministic first match, in provider-entry file
 *  order. Two entries with the same base URL + key are indistinguishable from the
 *  disk alone — that is information-theoretic, not a bug — so the answer must at
 *  least be stable across reads rather than arbitrary.
 *
 *  No DI, no IO — shared by renderer and main.
 *--------------------------------------------------------------------------------------------*/

import type { AiResolvedProvider } from '@universe-editor/platform'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  CodexAuthStatus,
  CodexSettings,
} from '@universe-editor/node-services'
import { deriveClaudeAuth, deriveCodexGateway } from './providerDerivation.js'

/**
 * The credential in effect on one host for one agent.
 *
 * `kind: 'provider'` without a `providerId` means a gateway credential is live
 * that matches no configured provider entry — a hand-written token, or one from
 * an external CLI. It is deliberately left unattributed: guessing an owner would
 * bill the session to the wrong account.
 */
export interface AgentActiveAuth {
  /** `subscription` = the agent's official login; `provider` = a gateway/API key. */
  readonly kind: 'subscription' | 'provider' | 'none'
  /** The matching provider entry id, when the on-disk credential is one we wrote. */
  readonly providerId?: string
}

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

/** Codex's built-in provider name; `model_provider` naming it means auth.json wins. */
const CODEX_BUILTIN_PROVIDER = 'openai'

/**
 * Claude's live credential, mirroring the SDK's resolution order:
 * `ANTHROPIC_AUTH_TOKEN` (+ base URL) > `ANTHROPIC_API_KEY` > OAuth login.
 *
 * The order must not fall through: when a gateway token is present but matches no
 * entry, that unknown gateway *is* what runs — the SDK never looks at
 * `ANTHROPIC_API_KEY` in that case, so neither may we.
 */
export function resolveClaudeActiveAuth(
  settings: ClaudeSettings,
  authStatus: ClaudeAuthStatus,
  providers: readonly AiResolvedProvider[],
): AgentActiveAuth {
  const env = settings.env ?? {}
  const authToken = nonEmpty(env[AUTH_TOKEN])
  const baseUrl = nonEmpty(env[BASE_URL])
  if (authToken !== undefined && baseUrl !== undefined) {
    return provider(matchClaudeGateway(providers, authToken, baseUrl))
  }
  const apiKey = nonEmpty(env[API_KEY])
  if (apiKey !== undefined) {
    return provider(matchClaudeApiKey(providers, apiKey))
  }
  // A base URL without a token is inert — the SDK ignores it.
  return { kind: authStatus.loggedIn && !authStatus.expired ? 'subscription' : 'none' }
}

/**
 * Codex's live credential. `model_provider` pointing at any custom provider block
 * means that block's gateway credential is in effect; the built-in `openai`
 * provider (named explicitly or left empty) falls through to auth.json, where a
 * ChatGPT login counts as the subscription.
 */
export function resolveCodexActiveAuth(
  settings: CodexSettings,
  authStatus: CodexAuthStatus,
  providers: readonly AiResolvedProvider[],
): AgentActiveAuth {
  const name = nonEmpty(asString(settings['model_provider']))
  if (name !== undefined && name !== CODEX_BUILTIN_PROVIDER) {
    const block = providerBlock(settings, name)
    const baseUrl = nonEmpty(asString(block?.['base_url']))
    const token = nonEmpty(asString(block?.['experimental_bearer_token']))
    const matched =
      baseUrl !== undefined && token !== undefined
        ? matchCodexGateway(providers, token, baseUrl)
        : undefined
    return provider(matched)
  }
  return { kind: authStatus.active === 'chatgpt' ? 'subscription' : 'none' }
}

function provider(providerId: string | undefined): AgentActiveAuth {
  return { kind: 'provider', ...(providerId !== undefined ? { providerId } : {}) }
}

function matchClaudeGateway(
  providers: readonly AiResolvedProvider[],
  authToken: string,
  baseUrl: string,
): string | undefined {
  for (const entry of providers) {
    const derived = deriveClaudeAuth(entry)
    if (
      derived?.kind === 'gateway' &&
      derived.authToken === authToken &&
      derived.baseUrl === baseUrl
    ) {
      return entry.id
    }
  }
  return undefined
}

function matchClaudeApiKey(
  providers: readonly AiResolvedProvider[],
  apiKey: string,
): string | undefined {
  for (const entry of providers) {
    const derived = deriveClaudeAuth(entry)
    if (derived?.kind === 'apiKey' && derived.apiKey === apiKey) return entry.id
  }
  return undefined
}

function matchCodexGateway(
  providers: readonly AiResolvedProvider[],
  apiKey: string,
  baseUrl: string,
): string | undefined {
  for (const entry of providers) {
    const derived = deriveCodexGateway(entry)
    if (derived !== undefined && derived.apiKey === apiKey && derived.baseUrl === baseUrl) {
      return entry.id
    }
  }
  return undefined
}

function providerBlock(settings: CodexSettings, name: string): Record<string, unknown> | undefined {
  const providers = settings['model_providers']
  if (!providers || typeof providers !== 'object') return undefined
  const block = (providers as Record<string, unknown>)[name]
  return block && typeof block === 'object' ? (block as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Blank env values are absent as far as every CLI is concerned. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}
