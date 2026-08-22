/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  providerDerivation: resolving a `providerRef` and flattening an instance +
 *  type into the per-CLI credential shapes.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProviderInstance, AiProviderType } from '@universe-editor/platform'
import {
  deriveClaudeEnv,
  deriveCodexProvider,
  providerSupportsProtocol,
  resolveProviderRef,
} from '../providerDerivation.js'

const openaiType: AiProviderType = {
  protocol: 'openai-chat',
  defaultBaseUrl: 'https://default.example.com',
}

function instance(overrides: Partial<AiProviderInstance> = {}): AiProviderInstance {
  return { name: 'gw', type: 'openai', apiKey: 'sk-1', ...overrides }
}

describe('resolveProviderRef', () => {
  it('resolves a matching ref to its instance + type', () => {
    const providers = [instance()]
    const types = { openai: openaiType }
    expect(resolveProviderRef('openai/gw', providers, types)).toEqual({
      instance: providers[0],
      type: openaiType,
    })
  })

  it('returns undefined when the instance is missing', () => {
    expect(resolveProviderRef('openai/nope', [instance()], { openai: openaiType })).toBeUndefined()
  })

  it('returns undefined when the type is missing', () => {
    expect(resolveProviderRef('custom/gw', [instance({ type: 'custom' })], {})).toBeUndefined()
  })

  it('returns undefined for a malformed ref', () => {
    expect(resolveProviderRef('', [instance()], { openai: openaiType })).toBeUndefined()
    expect(resolveProviderRef('nope', [instance()], { openai: openaiType })).toBeUndefined()
  })
})

describe('deriveClaudeEnv', () => {
  it('prefers instance.baseUrl over type.defaultBaseUrl', () => {
    expect(deriveClaudeEnv(instance({ baseUrl: 'https://inst.example.com' }), openaiType)).toEqual({
      authToken: 'sk-1',
      baseUrl: 'https://inst.example.com',
    })
  })

  it('falls back to the type default baseUrl', () => {
    expect(deriveClaudeEnv(instance(), openaiType)).toEqual({
      authToken: 'sk-1',
      baseUrl: 'https://default.example.com',
    })
  })

  it('returns undefined when the key is missing', () => {
    expect(deriveClaudeEnv({ name: 'gw', type: 'openai' }, openaiType)).toBeUndefined()
    expect(deriveClaudeEnv(instance({ apiKey: '' }), openaiType)).toBeUndefined()
  })

  it('returns undefined when the baseUrl is missing', () => {
    expect(
      deriveClaudeEnv({ name: 'gw', type: 'openai', apiKey: 'sk-1' }, { protocol: 'openai-chat' }),
    ).toBeUndefined()
  })
})

describe('deriveCodexProvider', () => {
  it('derives baseUrl + key + the display providerName', () => {
    expect(deriveCodexProvider(instance({ baseUrl: 'https://gw' }), openaiType)).toEqual({
      baseUrl: 'https://gw',
      apiKey: 'sk-1',
      providerName: 'gw',
    })
  })

  it('prefers the instance label over its name for the display providerName', () => {
    expect(
      deriveCodexProvider(instance({ name: 'kimi', label: 'Kimi Gateway' }), openaiType)
        ?.providerName,
    ).toBe('Kimi Gateway')
  })

  it('returns undefined when the key or baseUrl is missing', () => {
    expect(deriveCodexProvider({ name: 'gw', type: 'openai' }, openaiType)).toBeUndefined()
    expect(
      deriveCodexProvider(
        { name: 'gw', type: 'openai', apiKey: 'sk-1' },
        { protocol: 'openai-chat' },
      ),
    ).toBeUndefined()
  })
})

describe('providerSupportsProtocol', () => {
  it('matches the type default protocol', () => {
    expect(providerSupportsProtocol(instance(), openaiType, 'openai-chat')).toBe(true)
  })

  it('matches a model-level protocol override declared on the type models', () => {
    const type: AiProviderType = {
      protocol: 'openai-chat',
      models: [{ id: 'claude-sonnet', protocol: 'anthropic-messages' }],
    }
    expect(providerSupportsProtocol(instance(), type, 'anthropic-messages')).toBe(true)
  })

  it('matches a model-level protocol override declared on the instance models', () => {
    const type: AiProviderType = { protocol: 'openai-chat' }
    const inst = instance({ models: [{ id: 'gpt-5', protocol: 'openai-responses' }] })
    expect(providerSupportsProtocol(inst, type, 'openai-responses')).toBe(true)
  })

  it('does not match when neither the type nor any model declares the protocol', () => {
    const type: AiProviderType = {
      protocol: 'openai-chat',
      models: [{ id: 'ollama-model', protocol: 'ollama' }],
    }
    expect(providerSupportsProtocol(instance(), type, 'openai-responses')).toBe(false)
  })

  it('returns false when the type is missing', () => {
    expect(providerSupportsProtocol(instance(), undefined, 'openai-chat')).toBe(false)
  })
})
