/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { CancellationToken } from '../../base/cancellation.js'
import { AiModelRegistry } from '../../ai/aiModelRegistry.js'
import type { AiResolvedGroup } from '../../ai/aiModelConfiguration.js'
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

function group(vendor: string, name = 'default'): AiResolvedGroup {
  return { vendor, name, getApiKey: () => Promise.resolve(undefined) }
}

function fakeProvider(
  models: AiModelMetadata[],
  opts: { provideModels?: () => Promise<readonly AiModelMetadata[]> } = {},
): IAiModelProvider {
  return {
    provideModels: opts.provideModels ?? (() => Promise.resolve(models)),
    sendRequest: (): AiResponse => {
      throw new Error('not used')
    },
    provideTokenCount: () => Promise.resolve(0),
  }
}

describe('AiModelRegistry', () => {
  it('registers and resolves models across groups', async () => {
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([model('openai/default/gpt-4o', 'openai')]))
    reg.registerProvider('ollama', fakeProvider([model('ollama/default/llama3', 'ollama')]))
    reg.setGroups([group('openai'), group('ollama')])
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id).sort()
    expect(ids).toEqual(['ollama/default/llama3', 'openai/default/gpt-4o'])
    reg.dispose()
  })

  it('returns no models for a group whose vendor has no provider', async () => {
    const reg = new AiModelRegistry()
    reg.setGroups([group('openai')])
    expect(await reg.getModels(CancellationToken.None)).toEqual([])
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

  it('caches provideModels and invalidates on setGroups', async () => {
    const provideModels = vi.fn(() => Promise.resolve([model('openai/default/gpt-4o', 'openai')]))
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([], { provideModels }))
    reg.setGroups([group('openai')])

    await reg.getModels(CancellationToken.None)
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(1) // cached

    reg.setGroups([group('openai')]) // invalidate
    await reg.getModels(CancellationToken.None)
    expect(provideModels).toHaveBeenCalledTimes(2)
    reg.dispose()
  })

  it('dedups concurrent resolution of the same group', async () => {
    let resolveFn: (m: readonly AiModelMetadata[]) => void = () => {}
    const provideModels = vi.fn(
      () =>
        new Promise<readonly AiModelMetadata[]>((res) => {
          resolveFn = res
        }),
    )
    const reg = new AiModelRegistry()
    reg.registerProvider('openai', fakeProvider([], { provideModels }))
    reg.setGroups([group('openai')])

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
      'openai',
      fakeProvider([model('openai/default/gpt-4o', 'openai', 'gpt-4o')]),
    )
    reg.registerProvider(
      'ollama',
      fakeProvider([model('ollama/default/llama3', 'ollama', 'llama3')]),
    )
    reg.setGroups([group('openai'), group('ollama')])
    expect(await reg.selectModels({ vendor: 'ollama' }, CancellationToken.None)).toEqual([
      'ollama/default/llama3',
    ])
    expect(await reg.selectModels({ family: 'gpt-4o' }, CancellationToken.None)).toEqual([
      'openai/default/gpt-4o',
    ])
    reg.dispose()
  })

  it('resolveModel locates the owning provider and group', async () => {
    const reg = new AiModelRegistry()
    const p = fakeProvider([model('ollama/default/llama3', 'ollama')])
    reg.registerProvider('ollama', p)
    reg.setGroups([group('ollama')])
    const resolved = await reg.resolveModel('ollama/default/llama3', CancellationToken.None)
    expect(resolved?.provider).toBe(p)
    expect(resolved?.group.name).toBe('default')
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
    reg.registerProvider('openai', fakeProvider([], { provideModels }))
    reg.setGroups([group('openai')])

    await expect(reg.getModels(CancellationToken.None)).rejects.toThrow('transient')
    const ids = (await reg.getModels(CancellationToken.None)).map((m) => m.id)
    expect(ids).toEqual(['openai/default/gpt-4o'])
    reg.dispose()
  })
})
