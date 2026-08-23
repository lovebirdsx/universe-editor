/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  providerDerivation: flattening a single-layer resolved provider into the
 *  per-CLI credential shapes (Claude env vs Codex gateway), plus id lookup.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiResolvedProvider } from '@universe-editor/platform'
import { deriveClaudeAuth, deriveCodexGateway, findProviderById } from '../providerDerivation.js'

function provider(overrides: Partial<AiResolvedProvider> = {}): AiResolvedProvider {
  return {
    id: 'gw',
    defaultProtocol: 'anthropic-messages',
    protocols: [],
    apiKey: 'sk-1',
    ...overrides,
  }
}

describe('deriveClaudeAuth', () => {
  it('writes the api key for the official anthropic endpoint', () => {
    expect(deriveClaudeAuth(provider({ baseUrl: 'https://api.anthropic.com' }))).toEqual({
      kind: 'apiKey',
      apiKey: 'sk-1',
    })
  })

  it('treats a missing baseUrl as official and writes the api key', () => {
    expect(deriveClaudeAuth(provider())).toEqual({ kind: 'apiKey', apiKey: 'sk-1' })
  })

  it('writes the auth token + baseUrl for a gateway endpoint', () => {
    expect(deriveClaudeAuth(provider({ baseUrl: 'https://api.kuro.example/v1' }))).toEqual({
      kind: 'gateway',
      authToken: 'sk-1',
      baseUrl: 'https://api.kuro.example/v1',
    })
  })

  it('returns undefined without an api key', () => {
    const noKey = { id: 'gw', defaultProtocol: 'anthropic-messages', protocols: [] } as const
    expect(deriveClaudeAuth(noKey)).toBeUndefined()
    expect(deriveClaudeAuth(provider({ apiKey: '' }))).toBeUndefined()
  })

  it('returns undefined for an unresolved provider', () => {
    expect(deriveClaudeAuth(undefined)).toBeUndefined()
  })
})

describe('deriveCodexGateway', () => {
  it('derives baseUrl + key + the display providerName from the label', () => {
    expect(deriveCodexGateway(provider({ label: 'Kimi Gateway', baseUrl: 'https://gw' }))).toEqual({
      baseUrl: 'https://gw',
      apiKey: 'sk-1',
      providerName: 'Kimi Gateway',
    })
  })

  it('falls back to the provider id for the display providerName', () => {
    expect(deriveCodexGateway(provider({ baseUrl: 'https://gw' }))?.providerName).toBe('gw')
  })

  it('returns undefined when the key or baseUrl is missing', () => {
    const noKey = {
      id: 'gw',
      defaultProtocol: 'anthropic-messages',
      protocols: [],
      baseUrl: 'https://gw',
    } as const
    expect(deriveCodexGateway(noKey)).toBeUndefined()
    const noUrl = {
      id: 'gw',
      defaultProtocol: 'anthropic-messages',
      protocols: [],
      apiKey: 'sk-1',
    } as const
    expect(deriveCodexGateway(noUrl)).toBeUndefined()
  })

  it('returns undefined for an unresolved provider', () => {
    expect(deriveCodexGateway(undefined)).toBeUndefined()
  })
})

describe('findProviderById', () => {
  it('finds the provider with the matching id', () => {
    const a = provider({ id: 'a' })
    const b = provider({ id: 'b' })
    expect(findProviderById([a, b], 'b')).toBe(b)
  })

  it('returns undefined for an unknown or missing id', () => {
    expect(findProviderById([provider({ id: 'a' })], 'nope')).toBeUndefined()
    expect(findProviderById([provider({ id: 'a' })], undefined)).toBeUndefined()
  })
})
