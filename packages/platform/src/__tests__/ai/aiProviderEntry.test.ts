import { describe, expect, it } from 'vitest'
import {
  mergeModelKnowledge,
  resolveProviderEntries,
  type AiModelKnowledge,
  type AiProviderEntry,
} from '../../ai/aiProviderEntry.js'

const KNOWLEDGE: Readonly<Record<string, AiModelKnowledge>> = {
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    family: 'deepseek-v4',
    vendor: 'deepseek',
    nativeProtocol: 'openai-chat',
    maxInputTokens: 128000,
    capabilities: { streaming: true, vision: true, promptCaching: true },
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    vendor: 'anthropic',
    capabilities: { streaming: true, vision: true, promptCaching: true },
  },
}

function entry(id: string, rest: Omit<AiProviderEntry, 'id'> = {}): AiProviderEntry {
  return { id, ...rest }
}

describe('resolveProviderEntries — protocolMap', () => {
  it('keeps each protocol’s model set separate', () => {
    const { providers, issues } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: {
            'openai-chat': ['deepseek-v4-pro', 'glm5.3'],
            'anthropic-messages': ['deepseek-v4-pro'],
          },
        }),
      ],
      KNOWLEDGE,
    )

    expect(issues).toEqual([])
    const acme = providers[0]
    expect(acme?.protocols.map((p) => p.protocol)).toEqual(['openai-chat', 'anthropic-messages'])
    expect(acme?.protocols[0]?.models.map((m) => m.channelModel)).toEqual([
      'deepseek-v4-pro',
      'glm5.3',
    ])
    expect(acme?.protocols[1]?.models.map((m) => m.channelModel)).toEqual(['deepseek-v4-pro'])
  })

  it('marks an empty array as endpoint discovery rather than an empty catalog', () => {
    const { providers } = resolveProviderEntries(
      [entry('official', { protocolMap: { 'anthropic-messages': [] } })],
      KNOWLEDGE,
    )

    expect(providers[0]?.protocols[0]).toMatchObject({ discover: true, models: [] })
  })

  it('applies knowledge to a bare string ref', () => {
    const { providers } = resolveProviderEntries(
      [entry('acme', { protocolMap: { 'openai-chat': ['deepseek-v4-pro'] } })],
      KNOWLEDGE,
    )

    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.ref).toBe('deepseek-v4-pro')
    expect(model?.knowledge.vendor).toBe('deepseek')
    expect(model?.knowledge.maxInputTokens).toBe(128000)
  })

  it('degrades to an empty knowledge entry for an unknown model instead of failing', () => {
    const { providers, issues } = resolveProviderEntries(
      [entry('acme', { protocolMap: { 'openai-chat': ['never-heard-of-it'] } })],
      KNOWLEDGE,
    )

    expect(issues).toEqual([])
    expect(providers[0]?.protocols[0]?.models[0]).toEqual({
      channelModel: 'never-heard-of-it',
      ref: 'never-heard-of-it',
      knowledge: {},
    })
  })

  it('applies bare-name knowledge to a lane-suffixed string ref', () => {
    const knowledge: Readonly<Record<string, AiModelKnowledge>> = {
      'deepseek-v4-pro': {
        name: 'DeepSeek V4 Pro',
        supportsReasoningEffort: ['low', 'high', 'max'],
        maxInputTokens: 128000,
      },
    }
    const { providers, issues } = resolveProviderEntries(
      [entry('acme', { protocolMap: { 'anthropic-messages': ['deepseek-v4-pro[1m]'] } })],
      knowledge,
    )

    expect(issues).toEqual([])
    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.ref).toBe('deepseek-v4-pro[1m]')
    expect(model?.knowledge.supportsReasoningEffort).toEqual(['low', 'high', 'max'])
    expect(model?.knowledge.maxInputTokens).toBe(128000)
  })

  it('prefers an exact suffixed knowledge key over the bare-name fallback', () => {
    const knowledge: Readonly<Record<string, AiModelKnowledge>> = {
      'deepseek-v4-pro': {
        name: 'DeepSeek V4 Pro',
        supportsReasoningEffort: ['low', 'high', 'max'],
        maxInputTokens: 128000,
      },
      'deepseek-v4-pro[1m]': {
        name: 'DeepSeek V4 Pro [1m]',
        supportsReasoningEffort: ['low', 'high'],
        maxInputTokens: 1000000,
      },
    }
    const { providers } = resolveProviderEntries(
      [entry('acme', { protocolMap: { 'anthropic-messages': ['deepseek-v4-pro[1m]'] } })],
      knowledge,
    )

    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.knowledge.name).toBe('DeepSeek V4 Pro [1m]')
    expect(model?.knowledge.supportsReasoningEffort).toEqual(['low', 'high'])
    expect(model?.knowledge.maxInputTokens).toBe(1000000)
  })

  it('applies bare-name knowledge to a lane-suffixed override ref', () => {
    const knowledge: Readonly<Record<string, AiModelKnowledge>> = {
      'deepseek-v4-pro': {
        name: 'DeepSeek V4 Pro',
        supportsReasoningEffort: ['low', 'high', 'max'],
        maxInputTokens: 128000,
      },
    }
    const { providers } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: {
            'anthropic-messages': [
              { id: 'anthropic/deepseek-v4-pro[1m]', ref: 'deepseek-v4-pro[1m]' },
            ],
          },
        }),
      ],
      knowledge,
    )

    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.channelModel).toBe('anthropic/deepseek-v4-pro[1m]')
    expect(model?.ref).toBe('deepseek-v4-pro[1m]')
    expect(model?.knowledge.supportsReasoningEffort).toEqual(['low', 'high', 'max'])
    expect(model?.knowledge.maxInputTokens).toBe(128000)
  })

  it('separates the wire name from the knowledge key when the channel renamed a model', () => {
    const { providers } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: {
            'anthropic-messages': [{ id: 'anthropic/claude-opus-4-8', ref: 'claude-opus-4-8' }],
          },
        }),
      ],
      KNOWLEDGE,
    )

    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.channelModel).toBe('anthropic/claude-opus-4-8')
    expect(model?.ref).toBe('claude-opus-4-8')
    expect(model?.knowledge.vendor).toBe('anthropic')
  })

  it('lets a channel take capabilities away but never add them', () => {
    const { providers } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: {
            'openai-chat': [
              { ref: 'claude-opus-4-8', capabilities: { streaming: true, promptCaching: false } },
              // toolCalling is absent from the knowledge base — asking for it changes nothing
              { ref: 'deepseek-v4-pro', capabilities: { streaming: true, toolCalling: true } },
            ],
          },
        }),
      ],
      KNOWLEDGE,
    )

    const [claude, deepseek] = providers[0]?.protocols[0]?.models ?? []
    expect(claude?.knowledge.capabilities).toEqual({
      streaming: true,
      vision: true,
      promptCaching: false,
    })
    expect(deepseek?.knowledge.capabilities?.toolCalling).toBeUndefined()
  })

  it('lets an override change non-capability fields freely', () => {
    const { providers } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: { 'openai-chat': [{ ref: 'deepseek-v4-pro', maxOutputTokens: 4096 }] },
        }),
      ],
      KNOWLEDGE,
    )

    const model = providers[0]?.protocols[0]?.models[0]
    expect(model?.knowledge.maxOutputTokens).toBe(4096)
    expect(model?.knowledge.maxInputTokens).toBe(128000)
  })
})

describe('resolveProviderEntries — extends', () => {
  const base = entry('acme', {
    baseUrl: 'https://api.acme.example/v1',
    apiKey: 'base-key',
    defaultProtocol: 'openai-chat',
    protocolMap: { 'openai-chat': ['deepseek-v4-pro'], 'anthropic-messages': ['deepseek-v4-pro'] },
    pricingSource: { id: 'http-json' },
  })

  it('inherits everything the child does not restate', () => {
    const { providers, issues } = resolveProviderEntries(
      [base, entry('acme-gbl', { extends: 'acme', baseUrl: 'http://192.0.2.31:9080/v1' })],
      KNOWLEDGE,
    )

    expect(issues).toEqual([])
    const gbl = providers.find((p) => p.id === 'acme-gbl')
    expect(gbl?.baseUrl).toBe('http://192.0.2.31:9080/v1')
    expect(gbl?.apiKey).toBe('base-key')
    expect(gbl?.defaultProtocol).toBe('openai-chat')
    expect(gbl?.protocols.map((p) => p.protocol)).toEqual(['openai-chat', 'anthropic-messages'])
    expect(gbl?.pricingSource).toEqual({ id: 'http-json' })
  })

  it('replaces protocolMap wholesale rather than merging per protocol', () => {
    const { providers } = resolveProviderEntries(
      [base, entry('narrow', { extends: 'acme', protocolMap: { 'openai-chat': ['glm5.3'] } })],
      KNOWLEDGE,
    )

    const narrow = providers.find((p) => p.id === 'narrow')
    expect(narrow?.protocols.map((p) => p.protocol)).toEqual(['openai-chat'])
    expect(narrow?.protocols[0]?.models.map((m) => m.channelModel)).toEqual(['glm5.3'])
  })

  it('resolves a multi-level chain with the nearest layer winning', () => {
    const { providers, issues } = resolveProviderEntries(
      [
        base,
        entry('mid', { extends: 'acme', apiKey: 'mid-key' }),
        entry('leaf', { extends: 'mid', apiKey: 'leaf-key' }),
      ],
      KNOWLEDGE,
    )

    expect(issues).toEqual([])
    const leaf = providers.find((p) => p.id === 'leaf')
    expect(leaf?.apiKey).toBe('leaf-key')
    expect(leaf?.baseUrl).toBe('https://api.acme.example/v1')
  })

  it('skips an entry extending an id that does not exist, and says which', () => {
    const { providers, issues } = resolveProviderEntries(
      [base, entry('orphan', { extends: 'nope' })],
      KNOWLEDGE,
    )

    expect(providers.map((p) => p.id)).toEqual(['acme'])
    expect(issues).toEqual([
      { providerId: 'orphan', reason: 'unknown-extends', fatal: true, detail: 'nope' },
    ])
  })

  it('breaks a cycle instead of hanging', () => {
    const { providers, issues } = resolveProviderEntries(
      [entry('a', { extends: 'b' }), entry('b', { extends: 'a' })],
      KNOWLEDGE,
    )

    expect(providers).toEqual([])
    expect(issues.map((i) => i.reason)).toEqual(['extends-cycle', 'extends-cycle'])
  })

  it('rejects a chain deeper than the limit', () => {
    const chain: AiProviderEntry[] = [
      entry('p0', { protocolMap: { 'openai-chat': ['deepseek-v4-pro'] } }),
    ]
    for (let i = 1; i <= 9; i++) chain.push(entry(`p${i}`, { extends: `p${i - 1}` }))

    const { issues } = resolveProviderEntries(chain, KNOWLEDGE)
    expect(issues.some((i) => i.reason === 'extends-depth')).toBe(true)
  })

  // The limit counts entries, not hops: p0..p7 is 8 entries (7 hops) and resolves;
  // adding p8 makes 9 and trips it. Pinned so the boundary cannot drift silently.
  it.each([
    [7, true],
    [8, false],
  ])('accepts a chain of %i hops: %s', (hops, ok) => {
    const chain: AiProviderEntry[] = [
      entry('p0', { protocolMap: { 'openai-chat': ['deepseek-v4-pro'] } }),
    ]
    for (let i = 1; i <= hops; i++) chain.push(entry(`p${i}`, { extends: `p${i - 1}` }))

    const { providers, issues } = resolveProviderEntries(chain, KNOWLEDGE)
    expect(issues.some((i) => i.reason === 'extends-depth')).toBe(!ok)
    expect(providers.some((p) => p.id === `p${hops}`)).toBe(ok)
  })
})

describe('resolveProviderEntries — validation', () => {
  it.each([
    ['an empty id', ''],
    // Would compose to `a/b/openai-chat/m`, which parseModelRef cannot split back.
    ["an id containing '/'", 'a/b'],
  ])('reports %s instead of dropping the entry silently', (_name, id) => {
    const { providers, issues } = resolveProviderEntries(
      [entry(id, { protocolMap: { ollama: [] } })],
      KNOWLEDGE,
    )

    expect(providers).toEqual([])
    expect(issues).toEqual([{ providerId: id, reason: 'invalid-id', fatal: true }])
  })

  it('skips a duplicate id and keeps the first', () => {
    const { providers, issues } = resolveProviderEntries(
      [
        entry('dup', { baseUrl: 'first', protocolMap: { ollama: [] } }),
        entry('dup', { baseUrl: 'second', protocolMap: { ollama: [] } }),
      ],
      KNOWLEDGE,
    )

    expect(providers).toHaveLength(1)
    expect(providers[0]?.baseUrl).toBe('first')
    expect(issues).toEqual([{ providerId: 'dup', reason: 'duplicate-id', fatal: true }])
  })

  it('skips a provider that declares no protocol at all', () => {
    const { providers, issues } = resolveProviderEntries([entry('empty')], KNOWLEDGE)

    expect(providers).toEqual([])
    expect(issues).toEqual([{ providerId: 'empty', reason: 'no-protocol', fatal: true }])
  })

  it('falls back to the first protocol when defaultProtocol is not in the map, non-fatally', () => {
    const { providers, issues } = resolveProviderEntries(
      [
        entry('acme', {
          defaultProtocol: 'openai-responses',
          protocolMap: { 'openai-chat': ['deepseek-v4-pro'] },
        }),
      ],
      KNOWLEDGE,
    )

    expect(providers[0]?.defaultProtocol).toBe('openai-chat')
    expect(issues).toEqual([
      {
        providerId: 'acme',
        reason: 'unknown-default-protocol',
        fatal: false,
        detail: 'openai-responses',
      },
    ])
  })

  it('defaults to the first declared protocol when none is named', () => {
    const { providers } = resolveProviderEntries(
      [
        entry('acme', {
          protocolMap: { 'anthropic-messages': ['deepseek-v4-pro'], 'openai-chat': [] },
        }),
      ],
      KNOWLEDGE,
    )

    expect(providers[0]?.defaultProtocol).toBe('anthropic-messages')
  })
})

describe('mergeModelKnowledge', () => {
  it('merges per field so overriding one value keeps the rest of the builtin entry', () => {
    const merged = mergeModelKnowledge(KNOWLEDGE, {
      'claude-opus-4-8': { maxOutputTokens: 32000 },
    })

    expect(merged['claude-opus-4-8']).toEqual({
      name: 'Claude Opus 4.8',
      vendor: 'anthropic',
      capabilities: { streaming: true, vision: true, promptCaching: true },
      maxOutputTokens: 32000,
    })
  })

  it('adds entries the builtin base does not know', () => {
    const merged = mergeModelKnowledge(KNOWLEDGE, { 'glm5.3': { vendor: 'zhipu' } })

    expect(merged['glm5.3']).toEqual({ vendor: 'zhipu' })
    expect(merged['deepseek-v4-pro']?.vendor).toBe('deepseek')
  })

  it('returns the builtin base untouched when there is no user override', () => {
    expect(mergeModelKnowledge(KNOWLEDGE, undefined)).toBe(KNOWLEDGE)
  })
})
