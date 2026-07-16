/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { Emitter, StorageScope, type IStorageService } from '@universe-editor/platform'

/** In-memory IStorageService that only honors GLOBAL scope (enough for the store). */
function fakeStorage(seed: Record<string, unknown> = {}): IStorageService & {
  readonly data: Map<string, unknown>
} {
  const data = new Map<string, unknown>(Object.entries(seed))
  return {
    _serviceBrand: undefined,
    data,
    async get<T>(key: string, _scope?: StorageScope): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value)
    },
    async remove(key: string): Promise<void> {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: new Emitter<void>().event,
  }
}

describe('swarmReviewsUiStore', () => {
  // Module singleton; reset the registry per test to isolate the instance.
  async function freshStore() {
    vi.resetModules()
    const mod = await import('../swarmReviewsUiStore.js')
    return mod.swarmReviewsUiStore
  }

  it('defaults to expanded groups and empty keyword before attach', async () => {
    const store = await freshStore()
    expect(store.isReady).toBe(false)
    expect(store.keyword).toBe('')
    expect(store.collapsed).toEqual({ needsAction: false, ignored: false, authored: false })
  })

  it('flips isReady and fires onDidChange after hydration', async () => {
    const store = await freshStore()
    let changes = 0
    store.onDidChange(() => changes++)
    await store.attach(fakeStorage())
    expect(store.isReady).toBe(true)
    expect(changes).toBeGreaterThanOrEqual(1)
  })

  it('hydrates collapse + keyword from storage on attach', async () => {
    const store = await freshStore()
    await store.attach(
      fakeStorage({
        'swarm.reviewsView.collapsed': { needsAction: true, authored: true },
        'swarm.reviewsView.keyword': 'renderer',
      }),
    )
    expect(store.keyword).toBe('renderer')
    expect(store.collapsed).toEqual({ needsAction: true, ignored: false, authored: true })
  })

  it('persists collapse changes to GLOBAL storage and fires onDidChange', async () => {
    const store = await freshStore()
    const storage = fakeStorage()
    await store.attach(storage)

    let changes = 0
    store.onDidChange(() => changes++)

    store.setCollapsed('needsAction', true)
    expect(store.collapsed.needsAction).toBe(true)
    expect(storage.data.get('swarm.reviewsView.collapsed')).toMatchObject({ needsAction: true })
    expect(changes).toBe(1)

    // No-op when the value is unchanged.
    store.setCollapsed('needsAction', true)
    expect(changes).toBe(1)
  })

  it('persists keyword changes to GLOBAL storage', async () => {
    const store = await freshStore()
    const storage = fakeStorage()
    await store.attach(storage)

    store.setKeyword('fix')
    expect(store.keyword).toBe('fix')
    expect(storage.data.get('swarm.reviewsView.keyword')).toBe('fix')
  })

  it('attach is idempotent (contribution + view both attach)', async () => {
    const store = await freshStore()
    const first = store.attach(fakeStorage({ 'swarm.reviewsView.keyword': 'a' }))
    const second = store.attach(fakeStorage()) // second backend ignored
    expect(first).toBe(second)
    await first
    expect(store.keyword).toBe('a')
  })
})
