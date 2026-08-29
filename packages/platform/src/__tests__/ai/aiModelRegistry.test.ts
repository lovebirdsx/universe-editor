/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CancellationToken } from '../../base/cancellation.js'
import { AiModelRegistry } from '../../ai/aiModelRegistry.js'
import type {
  AiModelKnowledge,
  AiProviderRuntime,
  AiResolvedProtocol,
  AiResolvedProvider,
} from '../../ai/aiProviderEntry.js'
import type { IAiModelProvider } from '../../ai/aiModelProvider.js'
import type { AiResponse } from '../../ai/aiModelService.js'
import type { AiWireProtocol } from '../../ai/aiModelTypes.js'

function declared(protocol: AiWireProtocol, names: readonly string[]): AiResolvedProtocol {
  return {
    protocol,
    models: names.map((name) => ({ channelModel: name, ref: name, knowledge: {} })),
    discover: false,
  }
}

function discovering(protocol: AiWireProtocol): AiResolvedProtocol {
  return { protocol, models: [], discover: true }
}

function provider(
  id: string,
  protocols: readonly AiResolvedProtocol[],
  overrides: Partial<AiResolvedProvider> = {},
): AiResolvedProvider {
  const first = protocols[0]
  return {
    id,
    defaultProtocol: first?.protocol ?? 'openai-chat',
    protocols,
    ...overrides,
  }
}

function fakeProvider(
  listModels: (p: AiProviderRuntime, token: CancellationToken) => Promise<readonly string[]> = () =>
    Promise.resolve([]),
): IAiModelProvider {
  return {
    listModels,
    sendRequest: (): AiResponse => {
      throw new Error('not used')
    },
    provideTokenCount: () => Promise.resolve(0),
  }
}

describe('AiModelRegistry — declared models', () => {
  it('stamps a declared list into three-segment ids without touching the network', async () => {
    const listModels = vi.fn(() => Promise.resolve(['should-not-be-asked']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([
      provider('acme', [declared('openai-chat', ['acme-chat-pro', 'acme-chat-standard'])]),
    ])

    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual([
      'acme/openai-chat/acme-chat-pro',
      'acme/openai-chat/acme-chat-standard',
    ])
    expect(listModels).not.toHaveBeenCalled()
    reg.dispose()
  })

  it('keeps the same model under two protocols as two distinct ids', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider())
    reg.registerProvider('anthropic-messages', fakeProvider())
    reg.setProviders([
      provider('acme', [
        declared('openai-chat', ['acme-chat-pro']),
        declared('anthropic-messages', ['acme-chat-pro']),
      ]),
    ])

    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual([
      'acme/openai-chat/acme-chat-pro',
      'acme/anthropic-messages/acme-chat-pro',
    ])
    expect(models.map((m) => m.protocol)).toEqual(['openai-chat', 'anthropic-messages'])
    expect(models.every((m) => m.providerId === 'acme')).toBe(true)
    reg.dispose()
  })

  it('skips a declared protocol that has no registered provider', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider())
    reg.setProviders([
      provider('acme', [
        declared('openai-chat', ['gpt']),
        declared('anthropic-messages', ['claude']),
      ]),
    ])

    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual(['acme/openai-chat/gpt'])
    reg.dispose()
  })
})

describe('AiModelRegistry — endpoint discovery', () => {
  it('asks the provider to enumerate only for a protocol declared as []', async () => {
    const listModels = vi.fn(() => Promise.resolve(['llama3', 'qwen3']))
    const reg = new AiModelRegistry()
    reg.registerProvider('ollama', fakeProvider(listModels))
    reg.setProviders([provider('ollama', [discovering('ollama')])])

    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual(['ollama/ollama/llama3', 'ollama/ollama/qwen3'])
    expect(listModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })

  it('hands the provider a runtime carrying the entry credential and endpoint', async () => {
    const seen: AiProviderRuntime[] = []
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'openai-chat',
      fakeProvider((p) => {
        seen.push(p)
        return Promise.resolve(['gpt-4o'])
      }),
    )
    reg.setProviders([
      provider('openai-official', [discovering('openai-chat')], {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      }),
    ])

    await reg.getModels(CancellationToken.None)
    expect(seen).toEqual([
      {
        id: 'openai-official',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      },
    ])
    reg.dispose()
  })

  it('applies the knowledge base to a discovered model', async () => {
    const knowledge: Readonly<Record<string, AiModelKnowledge>> = {
      'claude-opus-4-8': {
        name: 'Claude Opus 4.8',
        family: 'claude-opus',
        vendor: 'anthropic',
        maxInputTokens: 200000,
        maxOutputTokens: 32000,
        capabilities: { streaming: true, vision: true },
      },
    }
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'anthropic-messages',
      fakeProvider(() => Promise.resolve(['claude-opus-4-8', 'mystery-model'])),
    )
    reg.setProviders(
      [provider('anthropic-official', [discovering('anthropic-messages')])],
      knowledge,
    )

    const [known, unknown] = await reg.getModels(CancellationToken.None)
    expect(known).toMatchObject({
      name: 'Claude Opus 4.8',
      family: 'claude-opus',
      vendor: 'anthropic',
      maxOutputTokens: 32000,
      capabilities: { streaming: true, vision: true },
    })
    // An unknown model degrades to the protocol's defaults rather than failing.
    expect(unknown).toMatchObject({
      name: 'mystery-model',
      family: 'mystery-model',
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
      capabilities: { streaming: true },
    })
    expect(unknown?.vendor).toBeUndefined()
    reg.dispose()
  })

  it('derives a configuration schema from the knowledge entry', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'openai-chat',
      fakeProvider(() => Promise.resolve(['o4'])),
    )
    reg.setProviders([provider('acme', [discovering('openai-chat')])], {
      o4: { supportsReasoningEffort: ['low', 'high'] },
    })

    const [model] = await reg.getModels(CancellationToken.None)
    expect(model?.configurationSchema?.reasoningEffort).toMatchObject({
      type: 'enum',
      enum: ['low', 'high'],
    })
    reg.dispose()
  })

  it('applies bare-name knowledge to a lane-suffixed discovered model', async () => {
    const knowledge: Readonly<Record<string, AiModelKnowledge>> = {
      'claude-opus-4-8': {
        name: 'Claude Opus 4.8',
        vendor: 'anthropic',
        maxInputTokens: 200000,
        supportsReasoningEffort: ['low', 'high', 'max'],
      },
    }
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'anthropic-messages',
      fakeProvider(() => Promise.resolve(['claude-opus-4-8[1m]'])),
    )
    reg.setProviders(
      [provider('anthropic-official', [discovering('anthropic-messages')])],
      knowledge,
    )

    const [model] = await reg.getModels(CancellationToken.None)
    expect(model).toMatchObject({
      name: 'Claude Opus 4.8',
      vendor: 'anthropic',
      maxInputTokens: 200000,
    })
    expect(model?.configurationSchema?.reasoningEffort).toMatchObject({
      type: 'enum',
      enum: ['low', 'high', 'max'],
    })
    reg.dispose()
  })
})

describe('AiModelRegistry — provider lifecycle', () => {
  it('rejects duplicate protocol registration', () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider())
    expect(() => reg.registerProvider('openai-chat', fakeProvider())).toThrow(/already registered/)
    reg.dispose()
  })

  it('unregister removes the provider and fires change', () => {
    const reg = new AiModelRegistry()
    const changes = vi.fn()
    reg.onDidChangeModels(changes)
    const d = reg.registerProvider('openai-chat', fakeProvider())
    expect(changes).toHaveBeenCalledTimes(1)
    d.dispose()
    expect(changes).toHaveBeenCalledTimes(2)
    expect(reg.getProvider('openai-chat')).toBeUndefined()
    reg.dispose()
  })

  it('caches enumeration and re-enumerates when a model-affecting field changes', async () => {
    const listModels = vi.fn(() => Promise.resolve(['gpt-4o']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    await reg.getModels(CancellationToken.None)
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(1)

    reg.setProviders([provider('acme', [discovering('openai-chat')], { apiKey: 'sk-live' })])
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(2)
    reg.dispose()
  })

  it('keeps the cached enumeration across a reload of presentation-only fields', async () => {
    const listModels = vi.fn(() => Promise.resolve(['gpt-4o']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(1)

    // pricingSource / usageSource do not touch what the provider serves.
    reg.setProviders([
      provider('acme', [discovering('openai-chat')], {
        pricingSource: { id: 'catalog' },
        usageSource: { id: 'http-json', options: { url: 'https://example.test/usage' } },
      }),
    ])
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })

  it('re-enumerates when baseUrl or apiKey changes', async () => {
    const listModels = vi.fn(() => Promise.resolve(['gpt-4o']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([
      provider('acme', [discovering('openai-chat')], {
        baseUrl: 'https://a.test/v1',
        apiKey: 'sk-1',
      }),
    ])

    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(1)

    reg.setProviders([
      provider('acme', [discovering('openai-chat')], {
        baseUrl: 'https://b.test/v1',
        apiKey: 'sk-1',
      }),
    ])
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(2)

    reg.setProviders([
      provider('acme', [discovering('openai-chat')], {
        baseUrl: 'https://b.test/v1',
        apiKey: 'sk-2',
      }),
    ])
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(3)
    reg.dispose()
  })

  it('re-enumerates when the protocol map changes', async () => {
    const listModels = vi.fn(() => Promise.resolve(['gpt-4o']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.registerProvider('anthropic-messages', fakeProvider())
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(1)

    reg.setProviders([
      provider('acme', [
        discovering('openai-chat'),
        declared('anthropic-messages', ['claude-opus-4-8']),
      ]),
    ])
    await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(2)
    reg.dispose()
  })

  it('re-enumerates discovered models when the knowledge base changes', async () => {
    const listModels = vi.fn(() => Promise.resolve(['o4']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])], {
      o4: { name: 'Omni 4' },
    })

    const [first] = await reg.getModels(CancellationToken.None)
    expect(first?.name).toBe('Omni 4')
    expect(listModels).toHaveBeenCalledTimes(1)

    reg.setProviders([provider('acme', [discovering('openai-chat')])], {
      o4: { name: 'Omni 4 Pro' },
    })
    const [second] = await reg.getModels(CancellationToken.None)
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(second?.name).toBe('Omni 4 Pro')
    reg.dispose()
  })

  it('rebuilds declared metadata when the knowledge base changes, without hitting the network', async () => {
    const listModels = vi.fn(() => Promise.resolve(['should-not-be-asked']))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders(
      [
        {
          id: 'acme',
          defaultProtocol: 'openai-chat' as const,
          protocols: [
            {
              protocol: 'openai-chat' as const,
              discover: false as const,
              models: [{ channelModel: 'o4', ref: 'o4', knowledge: { name: 'Omni 4' } }],
            },
          ],
        },
      ],
      { o4: { name: 'Omni 4' } },
    )

    const [first] = await reg.getModels(CancellationToken.None)
    expect(first?.name).toBe('Omni 4')

    reg.setProviders(
      [
        {
          id: 'acme',
          defaultProtocol: 'openai-chat' as const,
          protocols: [
            {
              protocol: 'openai-chat' as const,
              discover: false as const,
              models: [{ channelModel: 'o4', ref: 'o4', knowledge: { name: 'Omni 4 Pro' } }],
            },
          ],
        },
      ],
      { o4: { name: 'Omni 4 Pro' } },
    )

    const [second] = await reg.getModels(CancellationToken.None)
    expect(second?.name).toBe('Omni 4 Pro')
    expect(listModels).not.toHaveBeenCalled()
    reg.dispose()
  })

  it('keeps the knowledge base when setProviders omits it', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'openai-chat',
      fakeProvider(() => Promise.resolve(['o4'])),
    )
    reg.setProviders([provider('acme', [discovering('openai-chat')])], { o4: { name: 'Omni 4' } })
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    const [model] = await reg.getModels(CancellationToken.None)
    expect(model?.name).toBe('Omni 4')
    reg.dispose()
  })

  it('dedups concurrent resolution of the same entry', async () => {
    let resolveFn: (m: readonly string[]) => void = () => {}
    const listModels = vi.fn(
      () =>
        new Promise<readonly string[]>((res) => {
          resolveFn = res
        }),
    )
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    const p1 = reg.getModels(CancellationToken.None)
    const p2 = reg.getModels(CancellationToken.None)
    resolveFn(['gpt-4o'])
    await Promise.all([p1, p2])
    expect(listModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })

  // Discovery is best-effort — one offline endpoint must not fail the catalogue —
  // but a failed attempt must not be cached either, or the entry stays empty
  // until the next setProviders.
  it('re-resolves after a failed resolution (no poisoned cache)', async () => {
    let attempt = 0
    const listModels = vi.fn(() => {
      attempt++
      return attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve(['gpt-4o'])
    })
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    expect(await reg.getModels(CancellationToken.None)).toEqual([])
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id)
    expect(ids).toEqual(['acme/openai-chat/gpt-4o'])
    reg.dispose()
  })
})

describe('AiModelRegistry — lookup', () => {
  it('selectModels filters by real vendor and family', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider())
    // A declared ref carries its own resolved knowledge; the base is only for discovery.
    reg.setProviders([
      provider('acme', [
        {
          protocol: 'openai-chat',
          discover: false,
          models: [
            {
              channelModel: 'claude-opus-4-8',
              ref: 'claude-opus-4-8',
              knowledge: { vendor: 'anthropic', family: 'claude-opus' },
            },
            {
              channelModel: 'gpt-4o',
              ref: 'gpt-4o',
              knowledge: { vendor: 'openai', family: 'gpt-4o' },
            },
          ],
        },
      ]),
    ])

    expect(await reg.selectModels({ vendor: 'anthropic' }, CancellationToken.None)).toEqual([
      'acme/openai-chat/claude-opus-4-8',
    ])
    expect(await reg.selectModels({ family: 'gpt-4o' }, CancellationToken.None)).toEqual([
      'acme/openai-chat/gpt-4o',
    ])
    reg.dispose()
  })

  it('resolveModel locates the owning provider and its protocol runtime', async () => {
    const reg = new AiModelRegistry()
    const chat = fakeProvider()
    const messages = fakeProvider()
    reg.registerProvider('openai-chat', chat)
    reg.registerProvider('anthropic-messages', messages)
    reg.setProviders([
      provider('acme', [
        declared('openai-chat', ['acme-chat-pro']),
        declared('anthropic-messages', ['acme-chat-pro']),
      ]),
    ])

    const viaChat = await reg.resolveModel('acme/openai-chat/acme-chat-pro', CancellationToken.None)
    expect(viaChat?.provider).toBe(chat)
    expect(viaChat?.runtime.protocol).toBe('openai-chat')

    const viaMessages = await reg.resolveModel(
      'acme/anthropic-messages/acme-chat-pro',
      CancellationToken.None,
    )
    expect(viaMessages?.provider).toBe(messages)
    expect(viaMessages?.runtime.protocol).toBe('anthropic-messages')

    expect(await reg.resolveModel('missing', CancellationToken.None)).toBeUndefined()
    reg.dispose()
  })
})

describe('AiModelRegistry — one unreachable endpoint stays contained', () => {
  /** A listModels that never settles on its own, ignoring cancellation. */
  function hanging(calls: { n: number }): IAiModelProvider {
    return fakeProvider(() => {
      calls.n++
      return new Promise<readonly string[]>(() => {})
    })
  }

  it('bounds a hung endpoint by its own deadline instead of stalling the catalogue', async () => {
    vi.useFakeTimers()
    try {
      const reg = new AiModelRegistry()
      reg.registerProvider('ollama', hanging({ n: 0 }))
      reg.registerProvider(
        'openai-chat',
        fakeProvider(() => Promise.resolve(['fast-model'])),
      )
      reg.setProviders([
        provider('dead', [discovering('ollama')]),
        provider('live', [discovering('openai-chat')]),
      ])

      const pending = reg.getModels(CancellationToken.None)
      await vi.advanceTimersByTimeAsync(3_000)
      expect((await pending).map((m) => m.id)).toEqual(['live/openai-chat/fast-model'])
      reg.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolveModel goes straight to the owning entry, never probing a dead sibling', async () => {
    const calls = { n: 0 }
    const reg = new AiModelRegistry()
    reg.registerProvider('ollama', hanging(calls))
    reg.registerProvider('openai-chat', fakeProvider())
    // The dead entry is listed first, so a scanning resolve would hang here.
    reg.setProviders([
      provider('dead', [discovering('ollama')]),
      provider('live', [declared('openai-chat', ['gpt'])]),
    ])

    const resolved = await reg.resolveModel('live/openai-chat/gpt', CancellationToken.None)
    expect(resolved?.metadata.id).toBe('live/openai-chat/gpt')
    expect(calls.n).toBe(0)
    reg.dispose()
  })

  it('skips a just-timed-out endpoint, then probes it again once the cooldown lapses', async () => {
    vi.useFakeTimers()
    try {
      let down = true
      const listModels = vi.fn(() =>
        down
          ? new Promise<readonly string[]>(() => {})
          : Promise.resolve<readonly string[]>(['gpt-4o']),
      )
      const reg = new AiModelRegistry()
      reg.registerProvider('openai-chat', fakeProvider(listModels))
      reg.setProviders([provider('acme', [discovering('openai-chat')])])

      const first = reg.getModels(CancellationToken.None)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await first).toEqual([])
      expect(listModels).toHaveBeenCalledTimes(1)

      // Inside the cooldown the dead endpoint is not contacted at all, so this
      // resolves immediately rather than spending another full deadline.
      expect(await reg.getModels(CancellationToken.None)).toEqual([])
      expect(listModels).toHaveBeenCalledTimes(1)

      down = false
      await vi.advanceTimersByTimeAsync(31_000)
      expect((await reg.getModels(CancellationToken.None)).map((m) => m.id)).toEqual([
        'acme/openai-chat/gpt-4o',
      ])
      expect(listModels).toHaveBeenCalledTimes(2)
      reg.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a fast-failing endpoint right away — only hangs are worth deferring', async () => {
    let attempt = 0
    const listModels = vi.fn(() => {
      attempt++
      return attempt === 1
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve<readonly string[]>(['gpt-4o'])
    })
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider(listModels))
    reg.setProviders([provider('acme', [discovering('openai-chat')])])

    expect(await reg.getModels(CancellationToken.None)).toEqual([])
    expect((await reg.getModels(CancellationToken.None)).map((m) => m.id)).toEqual([
      'acme/openai-chat/gpt-4o',
    ])
    reg.dispose()
  })

  it('drops the cooldown when the entry changes, so a fixed endpoint retries at once', async () => {
    vi.useFakeTimers()
    try {
      let down = true
      const listModels = vi.fn(() =>
        down
          ? new Promise<readonly string[]>(() => {})
          : Promise.resolve<readonly string[]>(['gpt-4o']),
      )
      const reg = new AiModelRegistry()
      reg.registerProvider('openai-chat', fakeProvider(listModels))
      reg.setProviders([provider('acme', [discovering('openai-chat')])])

      const first = reg.getModels(CancellationToken.None)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await first).toEqual([])

      down = false
      reg.setProviders([provider('acme', [discovering('openai-chat')], { apiKey: 'ak-1' })])
      expect((await reg.getModels(CancellationToken.None)).map((m) => m.id)).toEqual([
        'acme/openai-chat/gpt-4o',
      ])
      expect(listModels).toHaveBeenCalledTimes(2)
      reg.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
