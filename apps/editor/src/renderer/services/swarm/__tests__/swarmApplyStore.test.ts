/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { Emitter, StorageScope, type IStorageService } from '@universe-editor/platform'

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

describe('swarmApplyStore', () => {
  // Module singleton; reset the registry per test to isolate.
  async function freshStore() {
    vi.resetModules()
    const mod = await import('../swarmApplyStore.js')
    return mod.swarmApplyStore
  }

  it('defaults to false and persists setIncludeOutside to GLOBAL storage', async () => {
    const store = await freshStore()
    const storage = fakeStorage()
    await store.attach(storage)

    let changes = 0
    store.onDidChange(() => changes++)

    expect(store.includeOutside).toBe(false)
    store.setIncludeOutside(true)
    expect(store.includeOutside).toBe(true)
    expect(changes).toBeGreaterThanOrEqual(1)
    expect(storage.data.get('swarm.applyToLocal.includeOutsideWorkspace')).toBe(true)
  })

  it('hydrates the persisted toggle on attach', async () => {
    const store = await freshStore()
    const storage = fakeStorage({ 'swarm.applyToLocal.includeOutsideWorkspace': true })
    expect(store.isReady).toBe(false)
    await store.attach(storage)
    expect(store.isReady).toBe(true)
    expect(store.includeOutside).toBe(true)
  })

  it('attach is idempotent (view + editor both mount)', async () => {
    const store = await freshStore()
    const storage = fakeStorage({ 'swarm.applyToLocal.includeOutsideWorkspace': true })
    await Promise.all([store.attach(storage), store.attach(storage)])
    expect(store.includeOutside).toBe(true)
    // setIncludeOutside with the same value is a no-op (no write, no fire).
    let changes = 0
    store.onDidChange(() => changes++)
    store.setIncludeOutside(true)
    expect(changes).toBe(0)
  })
})
