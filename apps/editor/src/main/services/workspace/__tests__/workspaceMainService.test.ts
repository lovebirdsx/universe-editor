/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/workspace/workspaceMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter, URI, type IRecentWorkspace } from '@universe-editor/platform'
import {
  CURRENT_WORKSPACE_STORAGE_KEY,
  RECENT_WORKSPACES_STORAGE_KEY,
  WorkspaceMainService,
  type IFolderDialog,
  type IWorkspaceScopedStorage,
} from '../workspaceMainService.js'

type FakeStorage = IWorkspaceScopedStorage & {
  store: Record<string, unknown>
  switchCalls: (string | null)[]
  flushCalls: number
}

function makeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const store = { ...initial }
  const scopeEmitter = new Emitter<void>()
  const switchCalls: (string | null)[] = []
  let flushCalls = 0
  return {
    _serviceBrand: undefined,
    store,
    switchCalls,
    get flushCalls() {
      return flushCalls
    },
    onDidChangeWorkspaceScope: scopeEmitter.event,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      store[key] = value
    },
    async remove(key: string): Promise<void> {
      delete store[key]
    },
    async switchWorkspace(id: string | null): Promise<void> {
      switchCalls.push(id)
    },
    async flush(): Promise<void> {
      flushCalls++
    },
  } as FakeStorage
}

function makeDialog(result: URI | null = null): IFolderDialog & { calls: number } {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async showOpenFolderDialog() {
      calls++
      return result
    },
  } as IFolderDialog & { calls: number }
}

describe('WorkspaceMainService', () => {
  it('starts with no current workspace and empty recent list', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog())
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  it('openFolder(URI) sets current, fires events, persists recent', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeDialog())
    const workspaceEvents: (string | null)[] = []
    const recentEvents: number[] = []
    svc.onDidChangeWorkspace((w) => workspaceEvents.push(w?.folder.toString() ?? null))
    svc.onDidChangeRecent((r) => recentEvents.push(r.length))

    const folder = URI.file('/tmp/my-project')
    await svc.openFolder(folder)

    await expect(svc.getCurrent()).resolves.toMatchObject({ name: 'my-project' })
    const recent = await svc.getRecent()
    expect(recent.length).toBe(1)
    expect(recent[0]?.folder.toString()).toBe(folder.toString())
    expect(workspaceEvents).toEqual([folder.toString()])
    expect(recentEvents).toEqual([1])
    // persisted under the storage key
    expect(storage.store[RECENT_WORKSPACES_STORAGE_KEY]).toBeDefined()
    svc.dispose()
  })

  it('openFolder() with no argument delegates to the folder dialog', async () => {
    const dialog = makeDialog(URI.file('/tmp/picked'))
    const svc = new WorkspaceMainService(makeStorage(), dialog)
    await svc.openFolder()
    expect(dialog.calls).toBe(1)
    await expect(svc.getCurrent()).resolves.toMatchObject({ name: 'picked' })
    svc.dispose()
  })

  it('openFolder() returning null from dialog keeps state unchanged', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog(null))
    await svc.openFolder()
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  // JSON.stringify([undefined]) → "[null]" over IPC, so the main process receives
  // null instead of undefined when the renderer calls openFolder() with no args.
  it('openFolder(null) — IPC path — delegates to the folder dialog same as undefined', async () => {
    const dialog = makeDialog(URI.file('/tmp/ipc-picked'))
    const svc = new WorkspaceMainService(makeStorage(), dialog)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.openFolder(null as any)
    expect(dialog.calls).toBe(1)
    await expect(svc.getCurrent()).resolves.toMatchObject({ name: 'ipc-picked' })
    svc.dispose()
  })

  it('opening the same folder twice keeps a single recent entry at the head', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog())
    const a = URI.file('/tmp/a')
    const b = URI.file('/tmp/b')
    await svc.openFolder(a)
    await svc.openFolder(b)
    await svc.openFolder(a)
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([a.toString(), b.toString()])
    svc.dispose()
  })

  it('caps recent list at 20 entries (LRU)', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog())
    for (let i = 0; i < 25; i++) {
      await svc.openFolder(URI.file(`/tmp/p${i}`))
    }
    const recent = await svc.getRecent()
    expect(recent.length).toBe(20)
    expect(recent[0]?.folder.toString()).toBe(URI.file('/tmp/p24').toString())
    svc.dispose()
  })

  it('clearRecent empties the list, fires event, and persists', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeDialog())
    await svc.openFolder(URI.file('/tmp/x'))
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    await svc.clearRecent()
    await expect(svc.getRecent()).resolves.toEqual([])
    expect(events).toEqual([0])
    expect(storage.store[RECENT_WORKSPACES_STORAGE_KEY]).toEqual([])
    svc.dispose()
  })

  it('closeFolder clears current but leaves recent intact', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog())
    await svc.openFolder(URI.file('/tmp/x'))
    await svc.closeFolder()
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    svc.dispose()
  })

  it('hydrates recent list from storage on first read', async () => {
    const folder = URI.file('/tmp/existing')
    const storage = makeStorage({
      [RECENT_WORKSPACES_STORAGE_KEY]: [
        { folder: folder.toJSON(), name: 'existing', lastOpened: 12345 },
      ],
    })
    const svc = new WorkspaceMainService(storage, makeDialog())
    const recent = await svc.getRecent()
    expect(recent.length).toBe(1)
    expect(recent[0]?.folder.toString()).toBe(folder.toString())
    expect(recent[0]?.name).toBe('existing')
    svc.dispose()
  })

  it('restoreCurrent fires onDidChangeWorkspace without touching recent', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeDialog())
    const events: (IRecentWorkspace[] | null)[] = []
    svc.onDidChangeRecent((r) => events.push(r as IRecentWorkspace[]))
    const restoreSpy = vi.fn()
    svc.onDidChangeWorkspace(restoreSpy)
    await svc.restoreCurrent({ folder: URI.file('/tmp/r'), name: 'r' })
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
    svc.dispose()
  })

  it('persists current workspace and rehydrates it on next start', async () => {
    const storage = makeStorage()
    const folder = URI.file('/tmp/persisted')

    const svc1 = new WorkspaceMainService(storage, makeDialog())
    await svc1.openFolder(folder)
    expect(storage.store[CURRENT_WORKSPACE_STORAGE_KEY]).toBeDefined()
    svc1.dispose()

    const svc2 = new WorkspaceMainService(storage, makeDialog())
    const current = await svc2.getCurrent()
    expect(current?.folder.toString()).toBe(folder.toString())
    expect(current?.name).toBe('persisted')
    svc2.dispose()
  })

  it('openFolder flushes storage and switches scope before firing onDidChangeWorkspace', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeDialog())
    let scopeAtFire: (string | null)[] = []
    svc.onDidChangeWorkspace(() => {
      scopeAtFire = [...storage.switchCalls]
    })
    await svc.openFolder(URI.file('/tmp/foo'))
    expect(storage.flushCalls).toBeGreaterThan(0)
    // switchWorkspace must have been called with a non-null id BEFORE the event fired
    expect(scopeAtFire.at(-1)).toBeTypeOf('string')
    expect(scopeAtFire.at(-1)).not.toBeNull()
    svc.dispose()
  })

  it('closeFolder switches storage scope to null before firing event', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeDialog())
    await svc.openFolder(URI.file('/tmp/foo'))
    storage.switchCalls.length = 0
    let scopeAtFire: (string | null)[] = []
    svc.onDidChangeWorkspace(() => {
      scopeAtFire = [...storage.switchCalls]
    })
    await svc.closeFolder()
    expect(scopeAtFire.at(-1)).toBeNull()
    svc.dispose()
  })

  it('closeFolder clears the persisted current entry', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeDialog())
    await svc.openFolder(URI.file('/tmp/x'))
    await svc.closeFolder()
    // Flush microtask so the fire-and-forget _persistCurrent has time to run.
    await new Promise((r) => setImmediate(r))
    expect(storage.store[CURRENT_WORKSPACE_STORAGE_KEY]).toBeNull()
    svc.dispose()
  })
})
