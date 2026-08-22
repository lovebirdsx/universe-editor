/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CancellationToken } from '../../base/cancellation.js'
import { AiModelRegistry } from '../../ai/aiModelRegistry.js'
import { composeModelId, type AiResolvedProvider } from '../../ai/aiModelConfiguration.js'
import type { IAiModelProvider } from '../../ai/aiModelProvider.js'
import type { AiModelMetadata } from '../../ai/aiModelTypes.js'
import type { AiResponse } from '../../ai/aiModelService.js'

function model(id: string, vendor: string, family = id): AiModelMetadata {
  return {
    id,
    vendor,
    name: id,
    family,
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true },
  }
}

function instance(overrides: Partial<AiResolvedProvider> = {}): AiResolvedProvider {
  return { type: 'openai', name: 'default', protocol: 'openai-chat', ...overrides }
}

function fakeProvider(
  models: AiModelMetadata[],
  opts: {
    provideModels?: (
      provider: AiResolvedProvider,
      token: CancellationToken,
    ) => Promise<readonly AiModelMetadata[]>
  } = {},
): IAiModelProvider {
  return {
    provideModels: opts.provideModels ?? (() => Promise.resolve(models)),
    sendRequest: (): AiResponse => {
      throw new Error('not used')
    },
    provideTokenCount: () => Promise.resolve(0),
  }
}

/** Derives models from a view's declaredModels, so per-bucket filtering is observable. */
function deriveModels(view: AiResolvedProvider): AiModelMetadata[] {
  return (view.declaredModels ?? []).map((m) =>
    model(composeModelId(view.type, view.name, m.id), view.type, m.family ?? m.id),
  )
}

describe('AiModelRegistry', () => {
  it('registers and resolves models across instances', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([model('openai/default/gpt-4o', 'openai')]))
    reg.registerProvider('ollama', fakeProvider([model('ollama/default/llama3', 'ollama')]))
    reg.setProviders([instance(), instance({ type: 'ollama', protocol: 'ollama' })])
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id).sort()
    expect(ids).toEqual(['ollama/default/llama3', 'openai/default/gpt-4o'])
    reg.dispose()
  })

  it('returns no models for an instance whose protocol has no provider', async () => {
    const reg = new AiModelRegistry()
    reg.setProviders([instance()])
    expect(await reg.getModels(CancellationToken.None)).toEqual([])
    reg.dispose()
  })

  it('rejects duplicate protocol registration', () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([]))
    expect(() => reg.registerProvider('openai-chat', fakeProvider([]))).toThrow(
      /already registered/,
    )
    reg.dispose()
  })

  it('unregister removes the provider and fires change', () => {
    const reg = new AiModelRegistry()
    const changes = vi.fn()
    reg.onDidChangeModels(changes)
    const d = reg.registerProvider('openai-chat', fakeProvider([]))
    expect(changes).toHaveBeenCalledTimes(1)
    d.dispose()
    expect(changes).toHaveBeenCalledTimes(2)
    expect(reg.getProvider('openai-chat')).toBeUndefined()
    reg.dispose()
  })

  it('caches provideModels and invalidates on setProviders', async () => {
    const provideModels = vi.fn(() => Promise.resolve([model('openai/default/gpt-4o', 'openai')]))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([], { provideModels }))
    reg.setProviders([instance()])

    await reg.getModels(CancellationToken.None)
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(1) // cached

    reg.setProviders([instance()]) // invalidate
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(2)
    reg.dispose()
  })

  it('dedups concurrent resolution of the same instance', async () => {
    let resolveFn: (m: readonly AiModelMetadata[]) => void = () => {}
    const provideModels = vi.fn(
      () =>
        new Promise<readonly AiModelMetadata[]>((res) => {
          resolveFn = res
        }),
    )
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([], { provideModels }))
    reg.setProviders([instance()])

    const p1 = reg.getModels(CancellationToken.None)
    const p2 = reg.getModels(CancellationToken.None)
    resolveFn([model('openai/default/gpt-4o', 'openai')])
    await Promise.all([p1, p2])
    expect(provideModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })

  it('selectModels filters by selector', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider(
      'openai-chat',
      fakeProvider([model('openai/default/gpt-4o', 'openai', 'gpt-4o')]),
    )
    reg.registerProvider(
      'ollama',
      fakeProvider([model('ollama/default/llama3', 'ollama', 'llama3')]),
    )
    reg.setProviders([instance(), instance({ type: 'ollama', protocol: 'ollama' })])
    expect(await reg.selectModels({ vendor: 'ollama' }, CancellationToken.None)).toEqual([
      'ollama/default/llama3',
    ])
    expect(await reg.selectModels({ family: 'gpt-4o' }, CancellationToken.None)).toEqual([
      'openai/default/gpt-4o',
    ])
    reg.dispose()
  })

  it('resolveModel locates the owning provider and resolved view', async () => {
    const reg = new AiModelRegistry()
    const p = fakeProvider([model('ollama/default/llama3', 'ollama')])
    reg.registerProvider('ollama', p)
    reg.setProviders([instance({ type: 'ollama', protocol: 'ollama' })])
    const resolved = await reg.resolveModel('ollama/default/llama3', CancellationToken.None)
    expect(resolved?.provider).toBe(p)
    expect(resolved?.resolved.name).toBe('default')
    expect(await reg.resolveModel('missing', CancellationToken.None)).toBeUndefined()
    reg.dispose()
  })

  it('re-resolves after a failed resolution (no poisoned cache)', async () => {
    let attempt = 0
    const provideModels = vi.fn(() => {
      attempt++
      return attempt === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve([model('openai/default/gpt-4o', 'openai')])
    })
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([], { provideModels }))
    reg.setProviders([instance()])

    await expect(reg.getModels(CancellationToken.None)).rejects.toThrow('transient')
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id)
    expect(ids).toEqual(['openai/default/gpt-4o'])
    reg.dispose()
  })

  it('buckets declared protocols and resolves to the matching provider', async () => {
    const openaiProvide = vi.fn((view: AiResolvedProvider) => Promise.resolve(deriveModels(view)))
    const anthropicProvide = vi.fn((view: AiResolvedProvider) =>
      Promise.resolve(deriveModels(view)),
    )
    const reg = new AiModelRegistry()
    const openaiProvider = fakeProvider([], { provideModels: openaiProvide })
    const anthropicProvider = fakeProvider([], { provideModels: anthropicProvide })
    reg.registerProvider('openai-chat', openaiProvider)
    reg.registerProvider('anthropic-messages', anthropicProvider)
    reg.setProviders([
      instance({
        declaredModels: [
          { id: 'gpt', protocol: 'openai-chat' },
          { id: 'claude', protocol: 'anthropic-messages' },
        ],
      }),
    ])
    await reg.getModels(CancellationToken.None)
    expect(openaiProvide).toHaveBeenCalledTimes(1)
    expect(anthropicProvide).toHaveBeenCalledTimes(1)

    expect((await reg.resolveModel('openai/default/gpt', CancellationToken.None))?.provider).toBe(
      openaiProvider,
    )
    expect(
      (await reg.resolveModel('openai/default/claude', CancellationToken.None))?.provider,
    ).toBe(anthropicProvider)
    reg.dispose()
  })

  it('routes a model with a baseUrl override into its own bucket', async () => {
    const provideModels = vi.fn((view: AiResolvedProvider) => Promise.resolve(deriveModels(view)))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([], { provideModels }))
    reg.setProviders([
      instance({ declaredModels: [{ id: 'gpt', baseUrl: 'https://custom.example/v1' }] }),
    ])
    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual(['openai/default/gpt'])
    expect(provideModels).toHaveBeenCalledTimes(2) // default bucket + override bucket
    const resolved = await reg.resolveModel('openai/default/gpt', CancellationToken.None)
    expect(resolved?.resolved.baseUrl).toBe('https://custom.example/v1')
    reg.dispose()
  })

  it('produces no models for a bucket whose protocol has no provider', async () => {
    const provideModels = vi.fn((view: AiResolvedProvider) => Promise.resolve(deriveModels(view)))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai-chat', fakeProvider([], { provideModels }))
    reg.setProviders([
      instance({
        declaredModels: [
          { id: 'gpt', protocol: 'openai-chat' },
          { id: 'claude', protocol: 'anthropic-messages' },
        ],
      }),
    ])
    const models = await reg.getModels(CancellationToken.None)
    expect(models.map((m) => m.id)).toEqual(['openai/default/gpt'])
    expect(provideModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })
})
