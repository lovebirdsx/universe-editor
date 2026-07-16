/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { Emitter, StorageScope, type IStorageService } from '@universe-editor/platform'
import type { SwarmReviewDto } from '@universe-editor/extensions-common'
import { splitIgnored } from '../swarmIgnoreStore.js'

function review(id: string, overrides: Partial<SwarmReviewDto> = {}): SwarmReviewDto {
  return {
    id,
    state: overrides.state ?? 'needsReview',
    stateLabel: overrides.stateLabel ?? 'Needs Review',
    author: overrides.author ?? 'alice',
    description: overrides.description ?? `review ${id}`,
    upVotes: overrides.upVotes ?? 0,
    downVotes: overrides.downVotes ?? 0,
    commentCount: overrides.commentCount ?? 0,
    openTaskCount: overrides.openTaskCount ?? 0,
    testStatus: overrides.testStatus ?? 'none',
    updated: overrides.updated ?? 0,
  }
}

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

describe('splitIgnored', () => {
  it('partitions reviews by id membership in the ignored set', () => {
    const reviews = [review('1'), review('2'), review('3')]
    const { active, ignored } = splitIgnored(reviews, new Set(['2']))
    expect(active.map((r) => r.id)).toEqual(['1', '3'])
    expect(ignored.map((r) => r.id)).toEqual(['2'])
  })

  it('returns everything as active when nothing is ignored', () => {
    const reviews = [review('1'), review('2')]
    const { active, ignored } = splitIgnored(reviews, new Set())
    expect(active).toHaveLength(2)
    expect(ignored).toHaveLength(0)
  })
})

describe('swarmIgnoreStore', () => {
  // The store is a module singleton; reset the module registry per test to isolate.
  async function freshStore() {
    vi.resetModules()
    const mod = await import('../swarmIgnoreStore.js')
    return mod.swarmIgnoreStore
  }

  it('ignore / unignore round-trips through storage and fires onDidChange', async () => {
    const store = await freshStore()
    const storage = fakeStorage()
    await store.attach(storage)

    let changes = 0
    store.onDidChange(() => changes++)

    expect(store.isIgnored('100')).toBe(false)
    store.ignore(review('100', { author: 'zouwei' }))
    expect(store.isIgnored('100')).toBe(true)
    expect(store.list()).toEqual(['100'])
    expect(store.getMeta('100')?.author).toBe('zouwei')
    expect(changes).toBeGreaterThanOrEqual(1)

    // Persisted to GLOBAL storage.
    expect(storage.data.get('swarm.ignoredReviews')).toEqual(['100'])

    store.unignore('100')
    expect(store.isIgnored('100')).toBe(false)
    expect(store.getMeta('100')).toBeUndefined()
    expect(storage.data.get('swarm.ignoredReviews')).toEqual([])
  })

  it('hydrates the ignored set + metadata from storage on attach', async () => {
    const store = await freshStore()
    const storage = fakeStorage({
      'swarm.ignoredReviews': ['8113801'],
      'swarm.ignoredReviewMeta': { '8113801': review('8113801', { author: 'zouwei' }) },
    })
    expect(store.isReady).toBe(false)
    await store.attach(storage)

    expect(store.isReady).toBe(true)
    expect(store.isIgnored('8113801')).toBe(true)
    expect(store.getMeta('8113801')?.author).toBe('zouwei')
  })

  it('attach is idempotent (view + editor both mount)', async () => {
    const store = await freshStore()
    const storage = fakeStorage({ 'swarm.ignoredReviews': ['1'] })
    const first = store.attach(storage)
    const second = store.attach(fakeStorage()) // second backend ignored
    expect(first).toBe(second)
    await first
    expect(store.list()).toEqual(['1'])
  })
})
