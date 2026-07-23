/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { Emitter, StorageScope, type IStorageService } from '@universe-editor/platform'
import type { SwarmReviewDetailDto, SwarmReviewDto } from '@universe-editor/extensions-common'
import {
  splitIgnored,
  reviewDtoFromDetail,
  firstNonEmptyLine,
  expiredIgnoredIds,
} from '../swarmIgnoreStore.js'

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

describe('firstNonEmptyLine', () => {
  it('skips leading blank lines and trims', () => {
    expect(firstNonEmptyLine('\n  \nReal summary\nmore body')).toBe('Real summary')
    expect(firstNonEmptyLine('only line')).toBe('only line')
    expect(firstNonEmptyLine('\n\n')).toBe('')
  })
})

describe('reviewDtoFromDetail', () => {
  it('rebuilds the snapshot fields from the detail, summarizing the description', () => {
    const prev = review('7769693', { description: '', upVotes: 5 })
    const detail: SwarmReviewDetailDto = {
      id: '7769693',
      state: 'needsReview',
      stateLabel: 'Needs Review',
      author: 'bob',
      description: '\nFix the widget\nlonger body',
      updated: 1_700_000_000_000,
      versions: [],
      participants: [
        { user: 'a', required: false, vote: 1 },
        { user: 'b', required: false, vote: -1 },
      ],
      transitions: [],
      commentCount: 3,
      openTaskCount: 1,
      testStatus: 'pass',
      stream: 'aki/branch_3.6',
    }
    const dto = reviewDtoFromDetail(detail, prev)
    expect(dto.id).toBe('7769693')
    expect(dto.description).toBe('Fix the widget')
    expect(dto.author).toBe('bob')
    expect(dto.upVotes).toBe(1)
    expect(dto.downVotes).toBe(1)
    expect(dto.commentCount).toBe(3)
    expect(dto.stream).toBe('aki/branch_3.6')
  })
})

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

describe('expiredIgnoredIds', () => {
  const DAY = 86_400_000
  const now = 10 * DAY

  it('expires snapshots older than the window, keeps the rest', () => {
    const metas = new Map<string, SwarmReviewDto>([
      ['old', review('old', { updated: now - 8 * DAY })],
      ['edge-in', review('edge-in', { updated: now - 7 * DAY })],
      ['fresh', review('fresh', { updated: now - DAY })],
    ])
    expect(expiredIgnoredIds(metas, 7, now)).toEqual(['old'])
  })

  it('never expires a snapshot with no updated time, and expires nothing when the window is disabled', () => {
    const metas = new Map<string, SwarmReviewDto>([
      ['no-time', review('no-time', { updated: 0 })],
      ['old', review('old', { updated: 1 })],
    ])
    expect(expiredIgnoredIds(metas, 7, now)).toEqual(['old'])
    expect(expiredIgnoredIds(metas, 0, now)).toEqual([])
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

  it('refreshMeta replaces the snapshot for an ignored review and persists it', async () => {
    const store = await freshStore()
    const storage = fakeStorage()
    await store.attach(storage)

    store.ignore(review('100', { description: '' }))
    let changes = 0
    store.onDidChange(() => changes++)

    store.refreshMeta(review('100', { description: 'healed title' }))
    expect(store.getMeta('100')?.description).toBe('healed title')
    expect(changes).toBe(1)
    const persisted = storage.data.get('swarm.ignoredReviewMeta') as Record<string, SwarmReviewDto>
    expect(persisted['100']?.description).toBe('healed title')

    // Unchanged data is a no-op (no persist, no event).
    store.refreshMeta(review('100', { description: 'healed title' }))
    expect(changes).toBe(1)
  })

  it('refreshMeta is a no-op for reviews that are not ignored', async () => {
    const store = await freshStore()
    await store.attach(fakeStorage())
    store.refreshMeta(review('100'))
    expect(store.getMeta('100')).toBeUndefined()
  })

  it('pruneExpired drops out-of-window ignored reviews, persists, and fires once', async () => {
    const DAY = 86_400_000
    const now = 10 * DAY
    const store = await freshStore()
    const storage = fakeStorage({
      'swarm.ignoredReviews': ['1', '2', '3'],
      'swarm.ignoredReviewMeta': {
        '1': review('1', { updated: now - 8 * DAY }),
        '2': review('2', { updated: now - DAY }),
        '3': review('3', { updated: 0 }),
      },
    })
    await store.attach(storage)

    let changes = 0
    store.onDidChange(() => changes++)

    store.pruneExpired(7, now)
    expect(store.list()).toEqual(['2', '3'])
    expect(store.getMeta('1')).toBeUndefined()
    expect(storage.data.get('swarm.ignoredReviews')).toEqual(['2', '3'])
    expect(changes).toBe(1)

    // Nothing left to prune: no persist, no event.
    store.pruneExpired(7, now)
    expect(changes).toBe(1)

    // Disabled window keeps everything.
    store.pruneExpired(0, now)
    expect(store.list()).toEqual(['2', '3'])
  })
})
