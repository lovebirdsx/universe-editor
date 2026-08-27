/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  Tests for shared/ai/agentActiveAuth.ts.
 *
 *  The load-bearing rules this file guards:
 *   1. Claude's priority order must not fall through. A gateway token that matches
 *      no entry still means "an unknown gateway is live" — the SDK ignores
 *      ANTHROPIC_API_KEY in that state, so resolution must not fall back to it.
 *   2. Whatever the panel writes must reverse-look-up to the same entry. The write
 *      and the read share `deriveClaudeAuth` / `deriveCodexGateway` precisely so
 *      this round trip cannot drift.
 *   3. Indistinguishable entries resolve to a deterministic first match, not an
 *      arbitrary one.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { resolveProviderEntries, type AiProviderEntry } from '@universe-editor/platform'
import type {
  ClaudeAuthStatus,
  ClaudeSettings,
  CodexAuthStatus,
  CodexSettings,
} from '@universe-editor/node-services'
import { resolveClaudeActiveAuth, resolveCodexActiveAuth } from '../agentActiveAuth.js'
import { deriveClaudeAuth, deriveCodexGateway, findProviderById } from '../providerDerivation.js'

const API_KEY = 'ANTHROPIC_API_KEY'
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN'
const BASE_URL = 'ANTHROPIC_BASE_URL'

const OFFICIAL_ANTHROPIC = 'https://api.anthropic.com'

/** Every entry needs a protocolMap, or resolveProviderEntries drops it as `no-protocol`. */
const PROTOCOLS = { 'anthropic-messages': [], 'openai-responses': [] } as const

const ENTRIES: readonly AiProviderEntry[] = [
  { id: 'gw-a', baseUrl: 'https://a.example.com', apiKey: 'key-a', protocolMap: PROTOCOLS },
  { id: 'gw-b', baseUrl: 'https://b.example.com', apiKey: 'key-b', protocolMap: PROTOCOLS },
  // Same endpoint + key as gw-a: indistinguishable from disk on purpose.
  { id: 'gw-a-twin', baseUrl: 'https://a.example.com', apiKey: 'key-a', protocolMap: PROTOCOLS },
  { id: 'official', baseUrl: OFFICIAL_ANTHROPIC, apiKey: 'sk-official', protocolMap: PROTOCOLS },
  { id: 'no-key', baseUrl: 'https://c.example.com', protocolMap: PROTOCOLS },
]

const providers = resolveProviderEntries(ENTRIES, {}).providers

function claudeEnv(env: Record<string, string>): ClaudeSettings {
  return { env }
}

const LOGGED_IN: ClaudeAuthStatus = { loggedIn: true, expired: false }
const LOGGED_OUT: ClaudeAuthStatus = { loggedIn: false, expired: false }
const EXPIRED: ClaudeAuthStatus = { loggedIn: true, expired: true }

describe('resolveClaudeActiveAuth', () => {
  it('matches a gateway by token + base URL', () => {
    const settings = claudeEnv({ [AUTH_TOKEN]: 'key-b', [BASE_URL]: 'https://b.example.com' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({
      kind: 'provider',
      providerId: 'gw-b',
    })
  })

  it('reports an unattributed provider for a gateway matching no entry — never falls through to the API key', () => {
    const settings = claudeEnv({
      [AUTH_TOKEN]: 'hand-written',
      [BASE_URL]: 'https://elsewhere.example.com',
      // Present but inert: the SDK never reads it while AUTH_TOKEN is set.
      [API_KEY]: 'sk-official',
    })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({ kind: 'provider' })
  })

  it('falls to the API key only when no gateway token is set', () => {
    const settings = claudeEnv({ [API_KEY]: 'sk-official' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({
      kind: 'provider',
      providerId: 'official',
    })
  })

  it('treats a token without a base URL as no gateway at all', () => {
    const settings = claudeEnv({ [AUTH_TOKEN]: 'key-b', [API_KEY]: 'sk-official' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({
      kind: 'provider',
      providerId: 'official',
    })
  })

  it('ignores a base URL with no token — the SDK does too', () => {
    const settings = claudeEnv({ [BASE_URL]: 'https://b.example.com' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({
      kind: 'subscription',
    })
  })

  it('treats blank env values as absent', () => {
    const settings = claudeEnv({ [AUTH_TOKEN]: '   ', [BASE_URL]: '', [API_KEY]: ' ' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers)).toEqual({
      kind: 'subscription',
    })
  })

  it('is subscription only while the OAuth login is valid', () => {
    expect(resolveClaudeActiveAuth({}, LOGGED_IN, providers)).toEqual({ kind: 'subscription' })
    expect(resolveClaudeActiveAuth({}, LOGGED_OUT, providers)).toEqual({ kind: 'none' })
    expect(resolveClaudeActiveAuth({}, EXPIRED, providers)).toEqual({ kind: 'none' })
  })

  it('resolves indistinguishable entries to the first in file order', () => {
    const settings = claudeEnv({ [AUTH_TOKEN]: 'key-a', [BASE_URL]: 'https://a.example.com' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_IN, providers).providerId).toBe('gw-a')
  })

  it('never attributes an entry with no key', () => {
    const settings = claudeEnv({ [AUTH_TOKEN]: '', [BASE_URL]: 'https://c.example.com' })
    expect(resolveClaudeActiveAuth(settings, LOGGED_OUT, providers)).toEqual({ kind: 'none' })
  })

  it('round-trips whatever applyAuthentication would write, for every entry with a key', () => {
    for (const id of ['gw-a', 'gw-b', 'official']) {
      const derived = deriveClaudeAuth(findProviderById(providers, id))
      expect(derived, id).toBeDefined()
      const env =
        derived?.kind === 'apiKey'
          ? { [API_KEY]: derived.apiKey }
          : { [AUTH_TOKEN]: derived!.authToken, [BASE_URL]: derived!.baseUrl }
      const resolved = resolveClaudeActiveAuth(claudeEnv(env), LOGGED_IN, providers)
      expect(resolved.kind, id).toBe('provider')
      // gw-a's twin shares its credential, so first-match is the guarantee here.
      expect(resolved.providerId, id).toBe(id)
    }
  })
})

const CHATGPT: CodexAuthStatus = { active: 'chatgpt', hasApiKey: false }
const CODEX_API_KEY: CodexAuthStatus = { active: 'apiKey', hasApiKey: true }
const CODEX_NONE: CodexAuthStatus = { active: 'none', hasApiKey: false }

function codexGateway(name: string, baseUrl: string, token: string): CodexSettings {
  return {
    model_provider: name,
    model_providers: { [name]: { base_url: baseUrl, experimental_bearer_token: token } },
  }
}

describe('resolveCodexActiveAuth', () => {
  it('matches the gateway block the editor writes', () => {
    const settings = codexGateway('codex-gateway', 'https://b.example.com', 'key-b')
    expect(resolveCodexActiveAuth(settings, CHATGPT, providers)).toEqual({
      kind: 'provider',
      providerId: 'gw-b',
    })
  })

  it('recognises a hand-written provider block under any name', () => {
    const settings = codexGateway('acme', 'https://a.example.com', 'key-a')
    expect(resolveCodexActiveAuth(settings, CHATGPT, providers)).toEqual({
      kind: 'provider',
      providerId: 'gw-a',
    })
  })

  it('reports an unattributed provider for a gateway matching no entry', () => {
    const settings = codexGateway('acme', 'https://elsewhere.example.com', 'nope')
    expect(resolveCodexActiveAuth(settings, CHATGPT, providers)).toEqual({ kind: 'provider' })
  })

  it('reports an unattributed provider for an incomplete custom block', () => {
    const settings: CodexSettings = {
      model_provider: 'acme',
      model_providers: { acme: { base_url: 'https://a.example.com' } },
    }
    expect(resolveCodexActiveAuth(settings, CHATGPT, providers)).toEqual({ kind: 'provider' })
  })

  it('falls through to auth.json for the built-in provider, named or empty', () => {
    expect(resolveCodexActiveAuth({}, CHATGPT, providers)).toEqual({ kind: 'subscription' })
    expect(resolveCodexActiveAuth({ model_provider: '' }, CHATGPT, providers)).toEqual({
      kind: 'subscription',
    })
    expect(resolveCodexActiveAuth({ model_provider: 'openai' }, CHATGPT, providers)).toEqual({
      kind: 'subscription',
    })
  })

  it('is not subscription when auth.json resolves to something other than ChatGPT', () => {
    expect(resolveCodexActiveAuth({}, CODEX_API_KEY, providers)).toEqual({ kind: 'none' })
    expect(resolveCodexActiveAuth({}, CODEX_NONE, providers)).toEqual({ kind: 'none' })
  })

  it('round-trips whatever applyCredential would write', () => {
    for (const id of ['gw-a', 'gw-b']) {
      const derived = deriveCodexGateway(findProviderById(providers, id))
      expect(derived, id).toBeDefined()
      const settings = codexGateway('codex-gateway', derived!.baseUrl, derived!.apiKey)
      expect(resolveCodexActiveAuth(settings, CHATGPT, providers).providerId, id).toBe(id)
    }
  })
})
