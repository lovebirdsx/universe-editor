/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/workspace/recentWorkspacesMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { Storage } from '../../../storage.js'
import {
  RECENT_WORKSPACES_STORAGE_KEY,
  RecentWorkspacesMainService,
} from '../recentWorkspacesMainService.js'

function makeStorage(initial: Record<string, unknown> = {}): Storage & {
  store: Record<string, unknown>
} {
  const store = { ...initial }
  return {
    store,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      store[key] = value
    },
    async remove(key: string): Promise<void> {
      delete store[key]
    },
    async flush(): Promise<void> {},
  } as Storage & { store: Record<string, unknown> }
}

describe('RecentWorkspacesMainService', () => {
  it('starts empty', async () => {
    const svc = new RecentWorkspacesMainService(makeStorage())
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  it('add prepends, fires event, and persists', async () => {
    const storage = makeStorage()
    const svc = new RecentWorkspacesMainService(storage)
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    const folder = URI.file('/tmp/my-project')
    await svc.add({ folder, name: 'my-project' })
    const recent = await svc.getRecent()
    expect(recent.length).toBe(1)
    expect(recent[0]?.folder.toString()).toBe(folder.toString())
    expect(events).toEqual([1])
    expect(storage.store[RECENT_WORKSPACES_STORAGE_KEY]).toBeDefined()
    svc.dispose()
  })

  it('adding the same folder twice keeps a single entry at the head', async () => {
    const svc = new RecentWorkspacesMainService(makeStorage())
    const a = URI.file('/tmp/a')
    const b = URI.file('/tmp/b')
    await svc.add({ folder: a, name: 'a' })
    await svc.add({ folder: b, name: 'b' })
    await svc.add({ folder: a, name: 'a' })
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([a.toString(), b.toString()])
    svc.dispose()
  })

  it('caps recent list at 20 entries (LRU)', async () => {
    const svc = new RecentWorkspacesMainService(makeStorage())
    for (let i = 0; i < 25; i++) {
      await svc.add({ folder: URI.file(`/tmp/p${i}`), name: `p${i}` })
    }
    const recent = await svc.getRecent()
    expect(recent.length).toBe(20)
    expect(recent[0]?.folder.toString()).toBe(URI.file('/tmp/p24').toString())
    svc.dispose()
  })

  it('clear empties the list, fires event, and persists', async () => {
    const storage = makeStorage()
    const svc = new RecentWorkspacesMainService(storage)
    await svc.add({ folder: URI.file('/tmp/x'), name: 'x' })
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    await svc.clear()
    await expect(svc.getRecent()).resolves.toEqual([])
    expect(events).toEqual([0])
    expect(storage.store[RECENT_WORKSPACES_STORAGE_KEY]).toEqual([])
    svc.dispose()
  })

  it('remove drops a single entry, fires event, and persists', async () => {
    const storage = makeStorage()
    const svc = new RecentWorkspacesMainService(storage)
    const a = URI.file('/tmp/a')
    const b = URI.file('/tmp/b')
    await svc.add({ folder: a, name: 'a' })
    await svc.add({ folder: b, name: 'b' })
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    await svc.remove(b)
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([a.toString()])
    expect(events).toEqual([1])
    svc.dispose()
  })

  it('remove of an unknown folder is a no-op (no event)', async () => {
    const svc = new RecentWorkspacesMainService(makeStorage())
    await svc.add({ folder: URI.file('/tmp/a'), name: 'a' })
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    await svc.remove(URI.file('/tmp/does-not-exist'))
    expect(events).toEqual([])
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    svc.dispose()
  })

  it('remove accepts UriComponents (post-IPC shape)', async () => {
    const svc = new RecentWorkspacesMainService(makeStorage())
    const a = URI.file('/tmp/a')
    await svc.add({ folder: a, name: 'a' })
    await svc.remove(a.toJSON())
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  it('hydrates from storage on first read, sorted by lastOpened desc', async () => {
    const older = URI.file('/tmp/older')
    const newer = URI.file('/tmp/newer')
    const storage = makeStorage({
      [RECENT_WORKSPACES_STORAGE_KEY]: [
        { folder: older.toJSON(), name: 'older', lastOpened: 100 },
        { folder: newer.toJSON(), name: 'newer', lastOpened: 200 },
      ],
    })
    const svc = new RecentWorkspacesMainService(storage)
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([newer.toString(), older.toString()])
    svc.dispose()
  })
})
