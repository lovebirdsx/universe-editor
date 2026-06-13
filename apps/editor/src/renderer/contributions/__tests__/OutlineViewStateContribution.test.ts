/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for OutlineViewStateContribution — hydrates the Outline view's
 *  preferences from GLOBAL storage on startup and writes them back on change,
 *  without echoing the just-loaded values straight back.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IStorageService, StorageScope } from '@universe-editor/platform'
import { OutlineViewStateContribution } from '../OutlineViewStateContribution.js'
import { outlineViewState } from '../../workbench/outline/outlineViewState.js'

const KEY = 'outline.viewState'

function fakeStorage(initial?: Record<string, unknown>): {
  service: IStorageService
  writes: unknown[]
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}))
  const writes: unknown[] = []
  const service = {
    _serviceBrand: undefined,
    async get<T>(key: string, _scope?: StorageScope): Promise<T | undefined> {
      return store.get(key) as T | undefined
    },
    async set(key: string, v: unknown): Promise<void> {
      store.set(key, v)
      writes.push(v)
    },
    async remove(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as IStorageService
  return { service, writes }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  outlineViewState.setFollowCursor(true)
  outlineViewState.setFilterOnType(true)
  outlineViewState.setSortBy('position')
})

let contrib: OutlineViewStateContribution | undefined
afterEach(() => {
  contrib?.dispose()
  contrib = undefined
})

describe('OutlineViewStateContribution', () => {
  it('hydrates preferences from storage', async () => {
    const storage = fakeStorage({
      [KEY]: { followCursor: false, filterOnType: false, sortBy: 'name' },
    })
    contrib = new OutlineViewStateContribution(storage.service)
    await flush()

    expect(outlineViewState.followCursor.get()).toBe(false)
    expect(outlineViewState.filterOnType.get()).toBe(false)
    expect(outlineViewState.sortBy.get()).toBe('name')
  })

  it('does not write back the just-hydrated values', async () => {
    const storage = fakeStorage({ [KEY]: { sortBy: 'kind' } })
    contrib = new OutlineViewStateContribution(storage.service)
    await flush()

    expect(storage.writes).toHaveLength(0)
  })

  it('persists a preference change', async () => {
    const storage = fakeStorage()
    contrib = new OutlineViewStateContribution(storage.service)
    await flush()

    outlineViewState.setSortBy('name')
    expect(storage.writes.at(-1)).toMatchObject({ sortBy: 'name' })
  })
})
