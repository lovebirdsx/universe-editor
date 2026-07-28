/*---------------------------------------------------------------------------------------------
 *  scmTreeState — per-repo persistence of the SCM tree's collapsed ids and
 *  scroll position: prefetch fills a synchronous cache, collapsed ids write
 *  back debounced, the scroll position writes immediately on unmount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Event, StorageScope, type IStorageService } from '@universe-editor/platform'
import {
  _resetScmTreeStateForTests,
  peekCollapsedIds,
  peekScrollTop,
  persistCollapsedIds,
  persistScrollTop,
  prefetchScmTreeState,
} from '../scmTreeState.js'

function makeStorage(): IStorageService & {
  data: Map<string, unknown>
  setCalls: Array<{ key: string; scope: StorageScope | undefined }>
} {
  const data = new Map<string, unknown>()
  const setCalls: Array<{ key: string; scope: StorageScope | undefined }> = []
  return {
    data,
    setCalls,
    _serviceBrand: undefined,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined
    },
    async set(key: string, value: unknown, scope?: StorageScope) {
      setCalls.push({ key, scope })
      data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
    onDidChangeWorkspaceScope: Event.None,
  }
}

const KEY = 'scm/treeState/file:///repo'

describe('scmTreeState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetScmTreeStateForTests()
  })
  afterEach(() => {
    _resetScmTreeStateForTests()
    vi.useRealTimers()
  })

  it('prefetch loads persisted state into the synchronous peek cache', async () => {
    const storage = makeStorage()
    storage.data.set(KEY, { collapsedIds: ['group:changes'], scrollTop: 120 })

    expect(peekCollapsedIds('file:///repo')).toBeUndefined()
    await prefetchScmTreeState(storage, 'file:///repo')

    expect(peekCollapsedIds('file:///repo')).toEqual(['group:changes'])
    expect(peekScrollTop('file:///repo')).toBe(120)
  })

  it('prefetch yields an empty diff when nothing was persisted', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///repo')
    expect(peekCollapsedIds('file:///repo')).toEqual([])
    expect(peekScrollTop('file:///repo')).toBeUndefined()
  })

  it('prefetch is idempotent and does not re-read storage', async () => {
    const storage = makeStorage()
    storage.data.set(KEY, { collapsedIds: ['group:a'] })
    await prefetchScmTreeState(storage, 'file:///repo')

    storage.data.set(KEY, { collapsedIds: ['group:changed-behind-our-back'] })
    await prefetchScmTreeState(storage, 'file:///repo')
    expect(peekCollapsedIds('file:///repo')).toEqual(['group:a'])
  })

  it('persists collapsed ids debounced under one key', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///repo')

    persistCollapsedIds(storage, 'file:///repo', ['group:changes'])
    expect(storage.data.has(KEY)).toBe(false) // still within the debounce window

    await vi.advanceTimersByTimeAsync(400)
    expect(storage.data.get(KEY)).toEqual({ collapsedIds: ['group:changes'] })
  })

  it('skips the write when the collapsed list is unchanged (refresh noise)', async () => {
    const storage = makeStorage()
    storage.data.set(KEY, { collapsedIds: ['group:changes'] })
    await prefetchScmTreeState(storage, 'file:///repo')

    const setSpy = vi.spyOn(storage, 'set')
    persistCollapsedIds(storage, 'file:///repo', ['group:changes'])
    await vi.advanceTimersByTimeAsync(400)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('persists the scroll position immediately (no debounce to lose on unload)', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///repo')

    persistScrollTop(storage, 'file:///repo', 240)
    // No timer advance — the write is issued synchronously.
    expect(storage.data.get(KEY)).toEqual({ collapsedIds: [], scrollTop: 240 })
    await vi.advanceTimersByTimeAsync(0) // flush the microtask queue only
    expect(peekScrollTop('file:///repo')).toBe(240)
  })

  it('keeps collapsed ids and scroll position under the same key', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///repo')

    persistCollapsedIds(storage, 'file:///repo', ['group:changes'])
    persistScrollTop(storage, 'file:///repo', 55)
    await vi.advanceTimersByTimeAsync(400)

    expect(storage.data.get(KEY)).toEqual({ collapsedIds: ['group:changes'], scrollTop: 55 })
  })

  it('treats collapsed lists as sets: reordering does not rewrite', async () => {
    const storage = makeStorage()
    storage.data.set(KEY, { collapsedIds: ['a', 'b'] })
    await prefetchScmTreeState(storage, 'file:///repo')

    const setSpy = vi.spyOn(storage, 'set')
    persistCollapsedIds(storage, 'file:///repo', ['b', 'a'])
    await vi.advanceTimersByTimeAsync(400)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('tracks repositories independently', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///one')
    await prefetchScmTreeState(storage, 'file:///two')

    persistCollapsedIds(storage, 'file:///one', ['group:a'])
    await vi.advanceTimersByTimeAsync(400)

    expect(storage.data.get('scm/treeState/file:///one')).toEqual({ collapsedIds: ['group:a'] })
    expect(storage.data.has('scm/treeState/file:///two')).toBe(false)
  })

  it('writes to WORKSPACE scope (folding is per-workspace state)', async () => {
    const storage = makeStorage()
    await prefetchScmTreeState(storage, 'file:///repo')
    persistScrollTop(storage, 'file:///repo', 10)
    expect(storage.setCalls).toEqual([{ key: KEY, scope: StorageScope.WORKSPACE }])
  })
})
