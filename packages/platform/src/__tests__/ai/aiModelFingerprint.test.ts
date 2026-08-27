/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelFingerprint.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  computeKnowledgeFingerprint,
  computeProviderModelFingerprint,
} from '../../ai/aiModelFingerprint.js'
import type { AiResolvedProvider } from '../../ai/aiProviderEntry.js'

function baseProvider(): AiResolvedProvider {
  return {
    id: 'acme',
    baseUrl: 'https://a.test/v1',
    apiKey: 'sk-1',
    defaultProtocol: 'openai-chat',
    protocols: [
      {
        protocol: 'openai-chat',
        discover: false,
        models: [{ channelModel: 'gpt-4o', ref: 'gpt-4o', knowledge: { name: 'GPT-4o' } }],
      },
    ],
  }
}

describe('computeProviderModelFingerprint', () => {
  it('is stable across two structurally equal providers', () => {
    expect(computeProviderModelFingerprint(baseProvider())).toBe(
      computeProviderModelFingerprint(baseProvider()),
    )
  })

  it('changes when baseUrl changes', () => {
    const other = { ...baseProvider(), baseUrl: 'https://b.test/v1' }
    expect(computeProviderModelFingerprint(other)).not.toBe(
      computeProviderModelFingerprint(baseProvider()),
    )
  })

  it('changes when apiKey changes', () => {
    const other = { ...baseProvider(), apiKey: 'sk-2' }
    expect(computeProviderModelFingerprint(other)).not.toBe(
      computeProviderModelFingerprint(baseProvider()),
    )
  })

  it('changes when the protocol map changes', () => {
    const other: AiResolvedProvider = {
      ...baseProvider(),
      protocols: [{ protocol: 'openai-chat', discover: true, models: [] }],
    }
    expect(computeProviderModelFingerprint(other)).not.toBe(
      computeProviderModelFingerprint(baseProvider()),
    )
  })

  it('changes when a declared model ref changes', () => {
    const base = baseProvider()
    const first = base.protocols[0]
    if (first === undefined) throw new Error('unreachable')
    const other: AiResolvedProvider = {
      ...base,
      protocols: [
        {
          ...first,
          models: [{ channelModel: 'gpt-4o', ref: 'gpt-4o-mini', knowledge: {} }],
        },
      ],
    }
    expect(computeProviderModelFingerprint(other)).not.toBe(computeProviderModelFingerprint(base))
  })

  it('changes when a declared model knowledge changes', () => {
    const base = baseProvider()
    const first = base.protocols[0]
    if (first === undefined) throw new Error('unreachable')
    const other: AiResolvedProvider = {
      ...base,
      protocols: [
        {
          ...first,
          models: [{ channelModel: 'gpt-4o', ref: 'gpt-4o', knowledge: { name: 'GPT-4o Mini' } }],
        },
      ],
    }
    expect(computeProviderModelFingerprint(other)).not.toBe(computeProviderModelFingerprint(base))
  })

  it('ignores pricingSource and usageSource', () => {
    const other: AiResolvedProvider = {
      ...baseProvider(),
      pricingSource: { id: 'catalog' },
      usageSource: { id: 'http-json', options: { url: 'https://example.test/usage' } },
    }
    expect(computeProviderModelFingerprint(other)).toBe(
      computeProviderModelFingerprint(baseProvider()),
    )
  })

  it('is insensitive to object key order', () => {
    const base = baseProvider()
    const reordered: AiResolvedProvider = {
      protocols: base.protocols,
      defaultProtocol: base.defaultProtocol,
      ...(base.apiKey !== undefined ? { apiKey: base.apiKey } : {}),
      ...(base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}),
      id: base.id,
    }
    expect(computeProviderModelFingerprint(reordered)).toBe(computeProviderModelFingerprint(base))
  })
})

describe('computeKnowledgeFingerprint', () => {
  it('is stable across two structurally equal bases', () => {
    const a = { 'gpt-4o': { name: 'GPT-4o', maxInputTokens: 128000 } }
    const b = { 'gpt-4o': { maxInputTokens: 128000, name: 'GPT-4o' } }
    expect(computeKnowledgeFingerprint(a)).toBe(computeKnowledgeFingerprint(b))
  })

  it('changes when any entry field changes', () => {
    const a = { 'gpt-4o': { name: 'GPT-4o' } }
    const b = { 'gpt-4o': { name: 'GPT-4o Mini' } }
    expect(computeKnowledgeFingerprint(a)).not.toBe(computeKnowledgeFingerprint(b))
  })

  it('changes when an entry is added or removed', () => {
    const a = { 'gpt-4o': { name: 'GPT-4o' } }
    const b = { 'gpt-4o': { name: 'GPT-4o' }, o4: { name: 'Omni 4' } }
    expect(computeKnowledgeFingerprint(a)).not.toBe(computeKnowledgeFingerprint(b))
  })
})
