/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelLane.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { lookupModelKnowledge, stripModelLaneSuffix } from '../../ai/aiModelLane.js'
import type { AiModelKnowledge } from '../../ai/aiProviderEntry.js'

describe('stripModelLaneSuffix', () => {
  it('drops a trailing bracket suffix', () => {
    expect(stripModelLaneSuffix('acme-chat-pro[1m]')).toBe('acme-chat-pro')
    expect(stripModelLaneSuffix('kimi-k3[high]')).toBe('kimi-k3')
  })

  it('drops an empty bracket suffix', () => {
    expect(stripModelLaneSuffix('acme-chat-pro[]')).toBe('acme-chat-pro')
  })

  it('leaves ids without a trailing suffix untouched', () => {
    expect(stripModelLaneSuffix('acme-chat-pro')).toBe('acme-chat-pro')
  })

  it('ignores brackets in the middle of an id', () => {
    expect(stripModelLaneSuffix('model[x]-2025')).toBe('model[x]-2025')
    expect(stripModelLaneSuffix('a[1m]b[1m]')).toBe('a[1m]b')
  })
})

describe('lookupModelKnowledge', () => {
  const KNOWLEDGE: Readonly<Record<string, AiModelKnowledge>> = {
    'acme-chat-pro': { name: 'Acme Chat Pro', maxInputTokens: 128000 },
    'acme-chat-pro[1m]': { name: 'Acme Chat Pro [1m]', maxInputTokens: 1000000 },
  }

  it('prefers the exact key over the bare-name fallback', () => {
    expect(lookupModelKnowledge(KNOWLEDGE, 'acme-chat-pro[1m]')).toEqual({
      name: 'Acme Chat Pro [1m]',
      maxInputTokens: 1000000,
    })
  })

  it('falls back to the bare name when only the exact key is missing', () => {
    expect(lookupModelKnowledge(KNOWLEDGE, 'kimi-k3[1m]')).toBeUndefined()
    const extended = { ...KNOWLEDGE, 'kimi-k3': { name: 'Kimi K3' } }
    expect(lookupModelKnowledge(extended, 'kimi-k3[1m]')).toEqual({ name: 'Kimi K3' })
  })

  it('returns undefined when neither key nor bare name is known', () => {
    expect(lookupModelKnowledge(KNOWLEDGE, 'never-heard-of-it')).toBeUndefined()
    expect(lookupModelKnowledge(KNOWLEDGE, 'never-heard-of-it[1m]')).toBeUndefined()
  })

  it('does not look up the bare name twice for an unsuffixed id', () => {
    const hits: string[] = []
    const knowledge: Record<string, AiModelKnowledge> = {}
    Object.defineProperty(knowledge, 'acme-chat-pro', {
      enumerable: true,
      get: () => {
        hits.push('acme-chat-pro')
        return { name: 'Acme Chat Pro' }
      },
    })

    expect(lookupModelKnowledge(knowledge, 'acme-chat-pro')).toEqual({
      name: 'Acme Chat Pro',
    })
    expect(hits).toEqual(['acme-chat-pro'])
  })
})
