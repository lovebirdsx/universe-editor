/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelConfiguration.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  bareModelName,
  composeModelId,
  parseModelRef,
  providerKey,
  resolveModelBaseUrl,
  resolveModelProtocol,
  resolveProviderInstances,
  type AiCustomModelConfig,
  type AiProviderType,
} from '../../ai/aiModelConfiguration.js'

describe('resolveProviderInstances', () => {
  const type: AiProviderType = {
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://type.example.com',
    requiresApiKey: true,
    models: [
      { id: 'gpt-4o', maxInputTokens: 1000 },
      { id: 'shared', family: 'type-family' },
    ],
    pricing: { input: 1, output: 2 },
  }

  it('merges type and instance models with instance winning on same id', () => {
    const resolved = resolveProviderInstances(
      [
        {
          type: 'openai',
          name: 'default',
          baseUrl: 'https://instance.example.com',
          models: [
            { id: 'gpt-4o-mini', maxOutputTokens: 500 },
            { id: 'shared', family: 'instance-family' },
          ],
        },
      ],
      { openai: type },
    )
    expect(resolved).toHaveLength(1)
    const [r] = resolved
    expect(r?.type).toBe('openai')
    expect(r?.name).toBe('default')
    expect(r?.baseUrl).toBe('https://instance.example.com')
    expect(r?.requiresApiKey).toBe(true)
    expect(r?.typePricing).toEqual({ input: 1, output: 2 })

    const ids = (r?.declaredModels ?? []).map((m) => m.id).sort()
    expect(ids).toEqual(['gpt-4o', 'gpt-4o-mini', 'shared'])
    const shared = (r?.declaredModels ?? []).find((m) => m.id === 'shared')
    expect(shared?.family).toBe('instance-family')
  })

  it('falls back to the type default baseUrl when the instance sets none', () => {
    const resolved = resolveProviderInstances([{ type: 'openai', name: 'default' }], {
      openai: type,
    })
    expect(resolved[0]?.baseUrl).toBe('https://type.example.com')
  })

  it('skips instances whose type is missing', () => {
    const resolved = resolveProviderInstances([{ type: 'missing', name: 'default' }], {
      openai: type,
    })
    expect(resolved).toEqual([])
  })
})

describe('resolveModelProtocol', () => {
  it('falls back to the type protocol', () => {
    expect(resolveModelProtocol(undefined, 'openai-chat')).toBe('openai-chat')
  })

  it('prefers the model override', () => {
    expect(resolveModelProtocol({ id: 'x', protocol: 'anthropic-messages' }, 'openai-chat')).toBe(
      'anthropic-messages',
    )
  })
})

describe('resolveModelBaseUrl', () => {
  it('prefers model override, then instance, then type default', () => {
    const model: AiCustomModelConfig = { id: 'x' }
    expect(resolveModelBaseUrl(model, 'https://i', 'https://t')).toBe('https://i')
    expect(resolveModelBaseUrl({ id: 'x', baseUrl: 'https://m' }, 'https://i', 'https://t')).toBe(
      'https://m',
    )
    expect(resolveModelBaseUrl(model, undefined, 'https://t')).toBe('https://t')
    expect(resolveModelBaseUrl(model, undefined, undefined)).toBeUndefined()
  })
})

describe('parseModelRef', () => {
  it('parses three segments', () => {
    expect(parseModelRef('openrouter/anthropic/claude')).toEqual({
      type: 'openrouter',
      instance: 'anthropic',
      model: 'claude',
    })
  })

  it('keeps any remaining / in the model segment', () => {
    expect(parseModelRef('openrouter/anthropic/claude/sonnet')).toEqual({
      type: 'openrouter',
      instance: 'anthropic',
      model: 'claude/sonnet',
    })
  })

  it('returns undefined for fewer than three segments', () => {
    expect(parseModelRef('openai/default')).toBeUndefined()
    expect(parseModelRef('gpt-4o')).toBeUndefined()
  })
})

describe('model id helpers', () => {
  it('composeModelId / bareModelName / providerKey round-trip', () => {
    expect(providerKey({ type: 'openai', name: 'default' })).toBe('openai/default')
    expect(composeModelId('openrouter', 'anthropic', 'claude')).toBe('openrouter/anthropic/claude')
    expect(bareModelName('openrouter/anthropic/claude', 'openrouter', 'anthropic')).toBe('claude')

    const id = composeModelId('openrouter', 'anthropic', 'claude/opus')
    expect(id).toBe('openrouter/anthropic/claude/opus')
    expect(bareModelName(id, 'openrouter', 'anthropic')).toBe('claude/opus')

    const ref = parseModelRef(id)
    expect(ref).toEqual({ type: 'openrouter', instance: 'anthropic', model: 'claude/opus' })
    if (ref) expect(composeModelId(ref.type, ref.instance, ref.model)).toBe(id)
  })
})
