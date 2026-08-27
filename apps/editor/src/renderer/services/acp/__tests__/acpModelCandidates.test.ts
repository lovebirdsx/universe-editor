import { describe, expect, it } from 'vitest'
import type { AiResolvedProvider } from '@universe-editor/platform'
import {
  CLAUDE_AGENT_PROTOCOL,
  MAX_EXTRA_MODELS,
  candidateModelsForProtocol,
  candidateModelCandidatesForProtocol,
  contextWindowFor,
  extraModelCandidatesForAgentSettings,
} from '../acpModelCandidates.js'

function provider(
  models: readonly string[],
  opts: {
    discover?: boolean
    protocol?: string
    windows?: Record<string, number>
    effortLevels?: Record<string, string[]>
  } = {},
): AiResolvedProvider {
  return {
    id: 'gw',
    defaultProtocol: 'anthropic-messages',
    protocols: [
      {
        protocol: (opts.protocol ?? 'anthropic-messages') as AiResolvedProvider['defaultProtocol'],
        discover: opts.discover === true,
        models: models.map((m) => ({
          channelModel: m,
          ref: m,
          knowledge: {
            ...(opts.windows?.[m] !== undefined ? { maxInputTokens: opts.windows[m] } : {}),
            ...(opts.effortLevels?.[m] !== undefined
              ? { supportsReasoningEffort: opts.effortLevels[m] }
              : {}),
          },
        })),
      },
    ],
  }
}

/** Id-only view of the candidate list — the shape most of these cases assert on. */
function ids(
  pick: string | undefined,
  p: AiResolvedProvider | undefined,
  protocol = CLAUDE_AGENT_PROTOCOL,
): readonly string[] {
  return extraModelCandidatesForAgentSettings(pick, p, protocol).map((c) => c.id)
}

describe('candidateModelsForProtocol', () => {
  it('returns the declared channel models', () => {
    expect(candidateModelsForProtocol(provider(['a', 'b']), CLAUDE_AGENT_PROTOCOL)).toEqual([
      'a',
      'b',
    ])
  })

  it('returns empty for an undefined provider', () => {
    expect(candidateModelsForProtocol(undefined, CLAUDE_AGENT_PROTOCOL)).toEqual([])
  })

  it('returns empty when the provider does not speak the protocol', () => {
    expect(
      candidateModelsForProtocol(
        provider(['a'], { protocol: 'openai-responses' }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([])
  })

  it('returns empty for a discover protocol — the file has no list to forward', () => {
    expect(
      candidateModelsForProtocol(provider([], { discover: true }), CLAUDE_AGENT_PROTOCOL),
    ).toEqual([])
  })
})

describe('extraModelCandidatesForAgentSettings (id ordering)', () => {
  it('carries the effective pick verbatim so the fork exact-matches the 1m lane', () => {
    expect(ids('deepseek-pro-v4[1m]', undefined)).toEqual(['deepseek-pro-v4[1m]'])
  })

  it('emits a bare pick as-is', () => {
    expect(ids('kimi-k3', undefined)).toEqual(['kimi-k3'])
  })

  it('merges provider candidates after the pick and dedupes', () => {
    expect(ids('b', provider(['a', 'b', 'c']))).toEqual(['b', 'a', 'c'])
  })

  it('returns provider candidates alone when no pick is set', () => {
    expect(ids(undefined, provider(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('ignores a blank pick', () => {
    expect(ids('   ', undefined)).toEqual([])
  })

  it('trims candidate ids', () => {
    expect(ids(' a ', provider([' b ']))).toEqual(['a', 'b'])
  })

  it('caps the payload but never at the expense of the user pick', () => {
    const many = Array.from({ length: MAX_EXTRA_MODELS + 10 }, (_, i) => `m${i}`)
    const out = ids('mine[1m]', provider(many))
    expect(out.length).toBe(MAX_EXTRA_MODELS)
    expect(out[0]).toBe('mine[1m]')
  })
})

describe('candidateModelCandidatesForProtocol', () => {
  it('carries the declared context window when knowledge has one', () => {
    expect(
      candidateModelCandidatesForProtocol(
        provider(['a', 'b'], { windows: { a: 128000 } }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([{ id: 'a', contextWindow: 128000 }, { id: 'b' }])
  })

  it('omits the window when knowledge has none', () => {
    expect(candidateModelCandidatesForProtocol(provider(['a']), CLAUDE_AGENT_PROTOCOL)).toEqual([
      { id: 'a' },
    ])
  })

  it('carries the declared effort levels when knowledge has them', () => {
    expect(
      candidateModelCandidatesForProtocol(
        provider(['a', 'b'], { effortLevels: { a: ['low', 'high'] } }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([{ id: 'a', effortLevels: ['low', 'high'] }, { id: 'b' }])
  })

  it('omits effort levels when knowledge has none', () => {
    expect(candidateModelCandidatesForProtocol(provider(['a']), CLAUDE_AGENT_PROTOCOL)).toEqual([
      { id: 'a' },
    ])
  })
})

describe('extraModelCandidatesForAgentSettings', () => {
  it('resolves the pick own window from the provider declaration', () => {
    expect(
      extraModelCandidatesForAgentSettings(
        'b',
        provider(['a', 'b'], { windows: { a: 100, b: 200 } }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([
      { id: 'b', contextWindow: 200 },
      { id: 'a', contextWindow: 100 },
    ])
  })

  it('leaves the pick window undefined when the provider does not declare it', () => {
    expect(
      extraModelCandidatesForAgentSettings('kimi-k3', undefined, CLAUDE_AGENT_PROTOCOL),
    ).toEqual([{ id: 'kimi-k3' }])
  })

  it('resolves the pick own effort levels from the provider declaration', () => {
    expect(
      extraModelCandidatesForAgentSettings(
        'b',
        provider(['a', 'b'], { effortLevels: { a: ['low'], b: ['low', 'medium', 'high'] } }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([
      { id: 'b', effortLevels: ['low', 'medium', 'high'] },
      { id: 'a', effortLevels: ['low'] },
    ])
  })

  it('leaves the pick effort levels undefined when the provider does not declare it', () => {
    expect(
      extraModelCandidatesForAgentSettings('kimi-k3', undefined, CLAUDE_AGENT_PROTOCOL),
    ).toEqual([{ id: 'kimi-k3' }])
  })

  it('matches a context-lane pick to the bare declared entry, carrying window and effort', () => {
    expect(
      extraModelCandidatesForAgentSettings(
        'acme-chat-pro[1m]',
        provider(['acme-chat-pro'], {
          windows: { 'acme-chat-pro': 1000000 },
          effortLevels: { 'acme-chat-pro': ['low', 'high', 'max'] },
        }),
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual([
      {
        id: 'acme-chat-pro[1m]',
        contextWindow: 1000000,
        effortLevels: ['low', 'high', 'max'],
      },
      {
        id: 'acme-chat-pro',
        contextWindow: 1000000,
        effortLevels: ['low', 'high', 'max'],
      },
    ])
  })
})

describe('contextWindowFor', () => {
  it('prefers the named model own window', () => {
    const candidates = [
      { id: 'a', contextWindow: 100 },
      { id: 'b', contextWindow: 200 },
    ]
    expect(contextWindowFor(candidates, 'b')).toBe(200)
  })

  it('matches a context-lane id to the bare candidate', () => {
    expect(
      contextWindowFor([{ id: 'acme-chat-pro', contextWindow: 1000000 }], 'acme-chat-pro[1m]'),
    ).toBe(1000000)
  })

  it('never guesses a window for an unnamed model', () => {
    // No pick means the agent's config file names no model, so the fork runs its
    // own default — candidates[0] is then just the provider's first declared
    // model, and injecting its window would hand one model's window to another.
    expect(
      contextWindowFor([{ id: 'a', contextWindow: 100 }, { id: 'b' }], undefined),
    ).toBeUndefined()
    expect(contextWindowFor([{ id: 'a', contextWindow: 100 }], '  ')).toBeUndefined()
  })

  it('never substitutes another model window for a named one', () => {
    const candidates = [{ id: 'a', contextWindow: 100 }, { id: 'b' }]
    // 'b' declares none and 'missing' is not a candidate at all (the remembered
    // model of a session opened under a provider the user has since switched
    // away from). Injecting 'a's 100 for either would mismanage the context.
    expect(contextWindowFor(candidates, 'b')).toBeUndefined()
    expect(contextWindowFor(candidates, 'missing')).toBeUndefined()
  })

  it('returns undefined when nothing is known', () => {
    expect(contextWindowFor([{ id: 'a' }], 'a')).toBeUndefined()
    expect(contextWindowFor([], 'a')).toBeUndefined()
    expect(contextWindowFor([], undefined)).toBeUndefined()
  })
})
