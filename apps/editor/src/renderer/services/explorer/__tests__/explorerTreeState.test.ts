/*---------------------------------------------------------------------------------------------
 *  explorerTreeState — per-root persistence of the Explorer tree's expanded
 *  directory ids: debounced writes with last-snapshot-wins, an immediate flush
 *  for teardown, and a root-scoped storage key that keeps a stray debounced
 *  write from leaking into the next workspace's bucket.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Event, StorageScope, URI, type IStorageService } from '@universe-editor/platform'
import {
  _resetExplorerTreeStateForTests,
  flushExpandedIdsWrite,
  persistExpandedIds,
  storageKeyForRoot,
} from '../explorerTreeState.js'

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

const root = URI.file('/ws')
const KEY = storageKeyForRoot(root)

describe('explorerTreeState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetExplorerTreeStateForTests()
  })
  afterEach(() => {
    _resetExplorerTreeStateForTests()
    vi.useRealTimers()
  })

  it('storageKeyForRoot carries the normalized root uri', () => {
    expect(KEY).toBe(`explorer/treeState/${root.toString()}`)
    // Different roots map to different keys (cross-workspace-write immunity).
    expect(storageKeyForRoot(URI.file('/other'))).not.toBe(KEY)
  })

  it('persists expanded ids debounced under the root key', async () => {
    const storage = makeStorage()
    persistExpandedIds(storage, KEY, ['file:///ws/a', 'file:///ws/a/b'])
    expect(storage.data.has(KEY)).toBe(false) // still within the debounce window

    await vi.advanceTimersByTimeAsync(400)
    expect(storage.data.get(KEY)).toEqual({
      expandedIds: ['file:///ws/a', 'file:///ws/a/b'],
    })
  })

  it('last snapshot wins: a newer set cancels the pending write', async () => {
    const storage = makeStorage()
    persistExpandedIds(storage, KEY, ['file:///ws/a'])
    persistExpandedIds(storage, KEY, ['file:///ws/a', 'file:///ws/b'])
    await vi.advanceTimersByTimeAsync(400)

    expect(storage.data.get(KEY)).toEqual({ expandedIds: ['file:///ws/a', 'file:///ws/b'] })
    expect(storage.setCalls).toHaveLength(1) // the superseded first write never landed
  })

  it('skips the write when the expanded set is unchanged (refresh noise)', async () => {
    const storage = makeStorage()
    persistExpandedIds(storage, KEY, ['a', 'b'])
    await vi.advanceTimersByTimeAsync(400)

    const setSpy = vi.spyOn(storage, 'set')
    persistExpandedIds(storage, KEY, ['b', 'a']) // reordering is not a change
    await vi.advanceTimersByTimeAsync(400)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('flushExpandedIdsWrite lands the pending set immediately', async () => {
    const storage = makeStorage()
    persistExpandedIds(storage, KEY, ['file:///ws/a'])
    flushExpandedIdsWrite(storage, KEY, [])

    await vi.advanceTimersByTimeAsync(0) // flush the microtask queue only
    expect(storage.data.get(KEY)).toEqual({ expandedIds: ['file:///ws/a'] })
  })

  it('writes to WORKSPACE scope (folding is per-workspace state)', async () => {
    const storage = makeStorage()
    persistExpandedIds(storage, KEY, ['file:///ws/a'])
    await vi.advanceTimersByTimeAsync(400)
    expect(storage.setCalls).toEqual([{ key: KEY, scope: StorageScope.WORKSPACE }])
  })
})
