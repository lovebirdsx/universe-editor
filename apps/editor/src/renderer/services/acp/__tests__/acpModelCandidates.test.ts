import { describe, expect, it } from 'vitest'
import type { AiResolvedProvider } from '@universe-editor/platform'
import {
  CLAUDE_AGENT_PROTOCOL,
  MAX_EXTRA_MODELS,
  candidateModelsForProtocol,
  extraModelsForAgentSettings,
} from '../acpModelCandidates.js'

function provider(
  models: readonly string[],
  opts: { discover?: boolean; protocol?: string } = {},
): AiResolvedProvider {
  return {
    id: 'gw',
    defaultProtocol: 'anthropic-messages',
    protocols: [
      {
        protocol: (opts.protocol ?? 'anthropic-messages') as AiResolvedProvider['defaultProtocol'],
        discover: opts.discover === true,
        models: models.map((m) => ({ channelModel: m, ref: m, knowledge: {} })),
      },
    ],
  }
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

describe('extraModelsForAgentSettings', () => {
  it('carries the pick in both spellings, effective first', () => {
    expect(
      extraModelsForAgentSettings(
        { model: 'deepseek-pro-v4', oneM: true },
        undefined,
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual(['deepseek-pro-v4[1m]', 'deepseek-pro-v4'])
  })

  it('emits the pick once when no lane is enabled', () => {
    expect(
      extraModelsForAgentSettings({ model: 'kimi-k3' }, undefined, CLAUDE_AGENT_PROTOCOL),
    ).toEqual(['kimi-k3'])
  })

  it('keeps a self-suffixed id verbatim without duplicating it', () => {
    expect(
      extraModelsForAgentSettings(
        { model: 'kimi-k3[1m]', oneM: true },
        undefined,
        CLAUDE_AGENT_PROTOCOL,
      ),
    ).toEqual(['kimi-k3[1m]'])
  })

  it('merges provider candidates after the pick and dedupes', () => {
    expect(
      extraModelsForAgentSettings({ model: 'b' }, provider(['a', 'b', 'c']), CLAUDE_AGENT_PROTOCOL),
    ).toEqual(['b', 'a', 'c'])
  })

  it('returns provider candidates alone when no pick is set', () => {
    expect(extraModelsForAgentSettings({}, provider(['a', 'b']), CLAUDE_AGENT_PROTOCOL)).toEqual([
      'a',
      'b',
    ])
  })

  it('ignores a blank pick', () => {
    expect(
      extraModelsForAgentSettings({ model: '   ', oneM: true }, undefined, CLAUDE_AGENT_PROTOCOL),
    ).toEqual([])
  })

  it('trims candidate ids', () => {
    expect(
      extraModelsForAgentSettings({ model: ' a ' }, provider([' b ']), CLAUDE_AGENT_PROTOCOL),
    ).toEqual(['a', 'b'])
  })

  it('caps the payload but never at the expense of the user pick', () => {
    const many = Array.from({ length: MAX_EXTRA_MODELS + 10 }, (_, i) => `m${i}`)
    const out = extraModelsForAgentSettings(
      { model: 'mine', oneM: true },
      provider(many),
      CLAUDE_AGENT_PROTOCOL,
    )
    expect(out.length).toBe(MAX_EXTRA_MODELS)
    expect(out[0]).toBe('mine[1m]')
    expect(out[1]).toBe('mine')
  })
})
