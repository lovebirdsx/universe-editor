/*---------------------------------------------------------------------------------------------
 *  Tests for AiRemoteCoordinator using stub sources (no network): stale-only refresh on
 *  setProviders, keeping the old cache when a source throws, skipping unregistered source
 *  ids, skipping sync sources (catalog) without fetch or cache, per-id concurrency dedup,
 *  and onDidChange firing only when something was written.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AiRemoteSourceRegistry,
  type AiRateTable,
  type AiResolvedProvider,
  type Event,
  type IAiPricingSource,
} from '@universe-editor/platform'
import { AiRemoteCache } from '../remote/remoteCache.js'
import { AiRemoteCoordinator } from '../remote/remoteCoordinator.js'

interface StubPricingSource extends IAiPricingSource {
  calls: number
  readonly sync?: boolean
}

function makePricingSource(
  id: string,
  fn: () => AiRateTable | undefined,
  sync = false,
): StubPricingSource {
  const source: StubPricingSource = {
    id,
    calls: 0,
    ...(sync ? { sync: true } : {}),
    async fetchRates(): Promise<AiRateTable | undefined> {
      source.calls++
      return fn()
    },
  }
  return source
}

function provider(id: string, sourceId: string): AiResolvedProvider {
  return {
    id,
    defaultProtocol: 'openai-chat',
    protocols: [{ protocol: 'openai-chat', models: [], discover: true }],
    pricingSource: { id: sourceId },
  }
}

function once(event: Event<void>): Promise<void> {
  return new Promise((resolve) => {
    const disposable = event(() => {
      disposable.dispose()
      resolve()
    })
  })
}

describe('AiRemoteCoordinator', () => {
  it('fetches stale entries on setProviders and skips fresh ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()
    cache.setRates('fresh', { m: { input: 1, output: 2 } }, Date.now())

    const pricing = makePricingSource('p1', () => ({ m: { input: 3, output: 4 } }))
    const registry = new AiRemoteSourceRegistry()
    registry.registerPricingSource(pricing)

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    const changed = once(coordinator.onDidChange)
    coordinator.setProviders([provider('fresh', 'p1'), provider('stale', 'p1')])
    await changed

    expect(pricing.calls).toBe(1)
    expect(cache.getRates('stale')?.rates).toEqual({ m: { input: 3, output: 4 } })
    // The fresh entry was not refetched.
    expect(cache.getRates('fresh')?.rates).toEqual({ m: { input: 1, output: 2 } })
    coordinator.dispose()
  })

  it('keeps the old cache when a source throws and never surfaces the error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()
    cache.setRates('a', { m: { input: 1, output: 2 } }, Date.now())

    const pricing = makePricingSource('p1', () => {
      throw new Error('boom')
    })
    const registry = new AiRemoteSourceRegistry()
    registry.registerPricingSource(pricing)

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    coordinator.setProviders([provider('a', 'p1')])

    await expect(coordinator.refresh('a')).resolves.toBeUndefined()
    expect(cache.getRates('a')?.rates).toEqual({ m: { input: 1, output: 2 } })
    coordinator.dispose()
  })

  it('skips a provider whose source id is not registered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()
    const registry = new AiRemoteSourceRegistry()

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    coordinator.setProviders([provider('a', 'nope')])

    await expect(coordinator.refresh('a')).resolves.toBeUndefined()
    expect(cache.getRates('a')).toBeUndefined()
    coordinator.dispose()
  })

  it('skips a sync source: never fetched, never cached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()

    const pricing = makePricingSource('catalog', () => ({ m: { input: 1, output: 2 } }), true)
    const registry = new AiRemoteSourceRegistry()
    registry.registerPricingSource(pricing)

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    coordinator.setProviders([provider('official', 'catalog')])

    await expect(coordinator.refresh('official')).resolves.toBeUndefined()
    expect(pricing.calls).toBe(0)
    expect(cache.getRates('official')).toBeUndefined()
    coordinator.dispose()
  })

  it('dedups concurrent refreshes of the same id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()

    const pricing = makePricingSource('p1', () => ({ m: { input: 1, output: 2 } }))
    const registry = new AiRemoteSourceRegistry()
    registry.registerPricingSource(pricing)

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    const changed = once(coordinator.onDidChange)
    coordinator.setProviders([provider('a', 'p1')])
    await changed
    expect(pricing.calls).toBe(1)

    await Promise.all([coordinator.refresh('a'), coordinator.refresh('a')])
    expect(pricing.calls).toBe(2)
    coordinator.dispose()
  })

  it('fires onDidChange only when a write happened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-remote-coord-'))
    const cache = new AiRemoteCache(async () => dir)
    await cache.load()

    let result: AiRateTable | undefined = undefined
    const pricing = makePricingSource('p1', () => result)
    const registry = new AiRemoteSourceRegistry()
    registry.registerPricingSource(pricing)

    const coordinator = new AiRemoteCoordinator({ registry, cache })
    let fired = 0
    coordinator.onDidChange(() => fired++)
    coordinator.setProviders([provider('a', 'p1')])

    // Background refresh fetches but the source yields nothing → no write, no event.
    await vi.waitFor(() => expect(pricing.calls).toBeGreaterThanOrEqual(1))
    expect(fired).toBe(0)

    result = { m: { input: 1, output: 2 } }
    await coordinator.refresh('a')
    expect(fired).toBe(1)
    coordinator.dispose()
  })
})
