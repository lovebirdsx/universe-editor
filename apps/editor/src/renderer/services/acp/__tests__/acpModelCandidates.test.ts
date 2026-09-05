import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AiResolvedProvider } from '@universe-editor/platform'
import {
  CLAUDE_AGENT_PROTOCOL,
  MAX_EXTRA_MODELS,
  candidateModelsForProtocol,
  candidateModelCandidatesForProtocol,
  contextWindowFor,
  extraModelCandidatesForAgentSettings,
  mergeModelCandidates,
  sessionModelCandidates,
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
    expect(ids('acme-chat-pro[1m]', undefined)).toEqual(['acme-chat-pro[1m]'])
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

describe('anthropic version-dot normalization', () => {
  it('rewrites dotted claude version segments to the hyphenated wire id', () => {
    expect(ids(undefined, provider(['claude-opus-4.8[1m]', 'claude-sonnet-4.5']))).toEqual([
      'claude-opus-4-8[1m]',
      'claude-sonnet-4-5',
    ])
  })

  it('normalizes the pick too, so the fork resolves the official id', () => {
    expect(ids('claude-opus-4.8[1m]', undefined)).toEqual(['claude-opus-4-8[1m]'])
  })

  it('leaves non-anthropic dotted ids untouched', () => {
    expect(ids(undefined, provider(['gpt-5.2-codex', 'deepseek-pro-v4', 'kimi-k3']))).toEqual([
      'gpt-5.2-codex',
      'deepseek-pro-v4',
      'kimi-k3',
    ])
  })

  it('leaves claude ids without a dotted version segment untouched', () => {
    expect(ids('claude-fable-5', undefined)).toEqual(['claude-fable-5'])
  })

  it('dedupes a dotted pick against the hyphenated declaration', () => {
    expect(ids('claude-opus-4.8[1m]', provider(['claude-opus-4-8[1m]']))).toEqual([
      'claude-opus-4-8[1m]',
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

  it('matches a dotted remembered id to the normalized candidate', () => {
    // Candidates are normalized to the hyphen spelling; a history/config pick
    // still spelled dotted must resolve to the same model's window.
    expect(
      contextWindowFor([{ id: 'claude-opus-4-8', contextWindow: 1000000 }], 'claude-opus-4.8'),
    ).toBe(1000000)
    expect(
      contextWindowFor(
        [{ id: 'claude-opus-4-8[1m]', contextWindow: 1000000 }],
        'claude-opus-4.8[1m]',
      ),
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

function selectOption(partial: Partial<SessionConfigOption>): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: '',
    ...partial,
  } as SessionConfigOption
}

describe('sessionModelCandidates', () => {
  it('returns the flat option values of the model select', () => {
    const bag = [
      selectOption({
        category: 'model',
        options: [
          { value: 'claude-opus-5', name: 'Opus 5' },
          { value: 'acme-chat-pro', name: 'Acme' },
        ],
      }),
    ]
    expect(sessionModelCandidates(bag)).toEqual(['claude-opus-5', 'acme-chat-pro'])
  })

  it('flattens grouped option shapes to their values', () => {
    const bag = [
      selectOption({
        category: 'model',
        options: [
          {
            group: 'official',
            name: 'Official',
            options: [{ value: 'claude-opus-5', name: 'Opus 5' }],
          },
          {
            group: 'extra',
            name: 'Gateway',
            options: [{ value: 'acme-chat-pro', name: 'Acme' }],
          },
        ],
      }),
    ]
    expect(sessionModelCandidates(bag)).toEqual(['claude-opus-5', 'acme-chat-pro'])
  })

  it('returns empty when the bag has no model option', () => {
    expect(sessionModelCandidates([])).toEqual([])
    expect(
      sessionModelCandidates([
        selectOption({ category: 'thought_level', options: [{ value: 'high', name: 'High' }] }),
      ]),
    ).toEqual([])
  })

  it('returns empty for a non-select model option', () => {
    const bag = [
      { id: 'model', category: 'model', type: 'boolean', name: 'Model', currentValue: false },
    ] as unknown as readonly SessionConfigOption[]
    expect(sessionModelCandidates(bag)).toEqual([])
  })
})

describe('mergeModelCandidates', () => {
  it('keeps list order, earlier lists first', () => {
    expect(mergeModelCandidates(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c'])
  })

  it('dedupes exact repeats across lists', () => {
    expect(mergeModelCandidates(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('dedupes dotted vs hyphenated spellings onto the normalized id', () => {
    expect(mergeModelCandidates(['claude-opus-4.8'], ['claude-opus-4-8'])).toEqual([
      'claude-opus-4-8',
    ])
  })

  it('trims and drops blank ids', () => {
    expect(mergeModelCandidates(['  a  ', '', '   '], ['b'])).toEqual(['a', 'b'])
  })

  it('handles any number of lists including none', () => {
    expect(mergeModelCandidates()).toEqual([])
    expect(mergeModelCandidates(['a'])).toEqual(['a'])
    expect(mergeModelCandidates([], ['a'], [])).toEqual(['a'])
  })
})
