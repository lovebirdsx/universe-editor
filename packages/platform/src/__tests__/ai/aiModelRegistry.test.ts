/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CancellationToken } from '../../base/cancellation.js'
import { Emitter } from '../../base/event.js'
import { AiModelRegistry } from '../../ai/aiModelRegistry.js'
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

function fakeProvider(
  models: AiModelMetadata[],
  opts: {
    onDidChange?: Emitter<void>
    provideModels?: () => Promise<readonly AiModelMetadata[]>
  } = {},
): IAiModelProvider {
  const provider: IAiModelProvider = {
    provideModels: opts.provideModels ?? (() => Promise.resolve(models)),
    sendRequest: (): AiResponse => {
      throw new Error('not used')
    },
    provideTokenCount: () => Promise.resolve(0),
  }
  if (opts.onDidChange) {
    return { ...provider, onDidChange: opts.onDidChange.event }
  }
  return provider
}

describe('AiModelRegistry', () => {
  it('registers and resolves models across providers', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([model('openai/gpt-4o', 'openai')]))
    reg.registerProvider('ollama', fakeProvider([model('ollama/llama3', 'ollama')]))
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id).sort()
    expect(ids).toEqual(['ollama/llama3', 'openai/gpt-4o'])
    reg.dispose()
  })

  it('rejects duplicate vendor registration', () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([]))
    expect(() => reg.registerProvider('openai', fakeProvider([]))).toThrow(/already registered/)
    reg.dispose()
  })

  it('unregister removes the provider and fires change', () => {
    const reg = new AiModelRegistry()
    const changes = vi.fn()
    reg.onDidChangeModels(changes)
    const d = reg.registerProvider('openai', fakeProvider([]))
    expect(changes).toHaveBeenCalledTimes(1)
    d.dispose()
    expect(changes).toHaveBeenCalledTimes(2)
    expect(reg.getProvider('openai')).toBeUndefined()
    reg.dispose()
  })

  it('caches provideModels and invalidates on provider change', async () => {
    const onChange = new Emitter<void>()
    const provideModels = vi.fn(() => Promise.resolve([model('openai/gpt-4o', 'openai')]))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([], { onDidChange: onChange, provideModels }))

    await reg.getModels(CancellationToken.None)
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(1) // cached

    onChange.fire() // invalidate
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(2)
    reg.dispose()
  })

  it('dedups concurrent resolution of the same vendor', async () => {
    let resolveFn: (m: readonly AiModelMetadata[]) => void = () => {}
    const provideModels = vi.fn(
      () =>
        new Promise<readonly AiModelMetadata[]>((res) => {
          resolveFn = res
        }),
    )
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([], { provideModels }))

    const p1 = reg.getModels(CancellationToken.None)
    const p2 = reg.getModels(CancellationToken.None)
    resolveFn([model('openai/gpt-4o', 'openai')])
    await Promise.all([p1, p2])
    expect(provideModels).toHaveBeenCalledTimes(1)
    reg.dispose()
  })

  it('selectModels filters by selector', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([model('openai/gpt-4o', 'openai', 'gpt-4o')]))
    reg.registerProvider('ollama', fakeProvider([model('ollama/llama3', 'ollama', 'llama3')]))
    expect(await reg.selectModels({ vendor: 'ollama' }, CancellationToken.None)).toEqual([
      'ollama/llama3',
    ])
    expect(await reg.selectModels({ family: 'gpt-4o' }, CancellationToken.None)).toEqual([
      'openai/gpt-4o',
    ])
    reg.dispose()
  })

  it('providerForModel locates the owning provider', async () => {
    const reg = new AiModelRegistry()
    const p = fakeProvider([model('ollama/llama3', 'ollama')])
    reg.registerProvider('ollama', p)
    expect(await reg.providerForModel('ollama/llama3', CancellationToken.None)).toBe(p)
    expect(await reg.providerForModel('missing', CancellationToken.None)).toBeUndefined()
    reg.dispose()
  })

  it('re-resolves after a failed resolution (no poisoned cache)', async () => {
    let attempt = 0
    const provideModels = vi.fn(() => {
      attempt++
      return attempt === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve([model('openai/gpt-4o', 'openai')])
    })
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([], { provideModels }))

    await expect(reg.getModels(CancellationToken.None)).rejects.toThrow('transient')
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id)
    expect(ids).toEqual(['openai/gpt-4o'])
    reg.dispose()
  })
})
