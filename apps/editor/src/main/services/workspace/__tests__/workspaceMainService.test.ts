/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/workspace/workspaceMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter, URI, type IRecentWorkspace } from '@universe-editor/platform'
import type { Storage } from '../../../storage.js'
import { type FolderOpenProbeFailure, type IWorkspaceFolderOpenGuard } from '../folderOpenGuard.js'
import { RecentWorkspacesMainService } from '../recentWorkspacesMainService.js'
import {
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

function makeRecents(initial: Record<string, unknown> = {}): RecentWorkspacesMainService {
  const store = { ...initial }
  const storage: Storage = {
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
    flushSync(): void {},
  }
  return new RecentWorkspacesMainService(storage)
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

function makeGuard(failure: FolderOpenProbeFailure | null) {
  const probes: string[] = []
  const reports: Array<{ folder: string; problem: string }> = []
  const guard: IWorkspaceFolderOpenGuard = {
    async probe(folder) {
      probes.push(folder.toString())
      return failure
    },
    async report(folder, f) {
      reports.push({ folder: folder.toString(), problem: f.problem })
    },
  }
  return { guard, probes, reports }
}

describe('WorkspaceMainService', () => {
  it('starts with no current workspace and empty recent list', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), makeDialog())
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  it('openFolder(URI) sets current, fires events, records recent', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), makeDialog())
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
    svc.dispose()
  })

  it('openFolder() with no argument delegates to the folder dialog', async () => {
    const dialog = makeDialog(URI.file('/tmp/picked'))
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), dialog)
    await svc.openFolder()
    expect(dialog.calls).toBe(1)
    await expect(svc.getCurrent()).resolves.toMatchObject({ name: 'picked' })
    svc.dispose()
  })

  it('openFolder() returning null from dialog keeps state unchanged', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), makeDialog(null))
    await svc.openFolder()
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  // JSON.stringify([undefined]) → "[null]" over IPC, so the main process receives
  // null instead of undefined when the renderer calls openFolder() with no args.
  it('openFolder(null) — IPC path — delegates to the folder dialog same as undefined', async () => {
    const dialog = makeDialog(URI.file('/tmp/ipc-picked'))
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), dialog)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.openFolder(null as any)
    expect(dialog.calls).toBe(1)
    await expect(svc.getCurrent()).resolves.toMatchObject({ name: 'ipc-picked' })
    svc.dispose()
  })

  it('openFolder proceeds normally when the guard accepts the folder', async () => {
    const storage = makeStorage()
    const recents = makeRecents()
    const folder = URI.file('/tmp/usable')
    const { guard, probes, reports } = makeGuard(null)
    const svc = new WorkspaceMainService(
      storage,
      recents,
      makeDialog(),
      undefined,
      undefined,
      guard,
    )

    await svc.openFolder(folder)

    expect(probes).toEqual([folder.toString()])
    expect(reports).toEqual([])
    expect(svc.current?.folder.toString()).toBe(folder.toString())
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    // First open hydrates (switches to the empty scope), then the workspace scope.
    expect(storage.switchCalls.at(-1)).not.toBeNull()
    svc.dispose()
  })

  it.each(['not-found', 'not-a-directory'] as const)(
    'openFolder aborts and drops the recent entry on %s',
    async (problem) => {
      const storage = makeStorage()
      const recents = makeRecents()
      const folder = URI.file('/tmp/gone')
      await recents.add({ folder, name: 'gone' })
      const { guard, probes, reports } = makeGuard({ problem })
      const svc = new WorkspaceMainService(
        storage,
        recents,
        makeDialog(),
        undefined,
        undefined,
        guard,
      )
      const workspaceEvents: unknown[] = []
      svc.onDidChangeWorkspace((w) => workspaceEvents.push(w))

      await svc.openFolder(folder)

      expect(probes).toEqual([folder.toString()])
      expect(svc.current).toBeNull()
      await expect(svc.getRecent()).resolves.toEqual([])
      expect(reports).toEqual([{ folder: folder.toString(), problem }])
      expect(workspaceEvents).toEqual([])
      expect(storage.switchCalls).toEqual([])
      svc.dispose()
    },
  )

  it('openFolder keeps the recent entry when the folder is unavailable', async () => {
    const recents = makeRecents()
    const folder = URI.file('/tmp/locked')
    await recents.add({ folder, name: 'locked' })
    const { guard, reports } = makeGuard({
      problem: 'unavailable',
      error: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    })
    const svc = new WorkspaceMainService(
      makeStorage(),
      recents,
      makeDialog(),
      undefined,
      undefined,
      guard,
    )

    await svc.openFolder(folder)

    expect(svc.current).toBeNull()
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    expect(reports).toEqual([{ folder: folder.toString(), problem: 'unavailable' }])
    svc.dispose()
  })

  it('openFolder probes before focusing an already-open window', async () => {
    const interceptor = vi.fn(() => true)
    const { guard } = makeGuard({ problem: 'not-found' })
    const svc = new WorkspaceMainService(
      makeStorage(),
      makeRecents(),
      makeDialog(),
      undefined,
      interceptor,
      guard,
    )

    await svc.openFolder(URI.file('/tmp/gone'))

    expect(interceptor).not.toHaveBeenCalled()
    expect(svc.current).toBeNull()
    svc.dispose()
  })

  it('openFolder skips the guard for remote folders', async () => {
    const { guard, probes } = makeGuard({ problem: 'not-found' })
    const folder = URI.parse('remote-ssh://e2e-local/home/dev/project')
    const svc = new WorkspaceMainService(
      makeStorage(),
      makeRecents(),
      makeDialog(),
      undefined,
      undefined,
      guard,
    )

    await svc.openFolder(folder)

    expect(probes).toEqual([])
    expect(svc.current?.folder.toString()).toBe(folder.toString())
    svc.dispose()
  })

  it('openFolder still resolves when the guard report rejects', async () => {
    const guard: IWorkspaceFolderOpenGuard = {
      async probe() {
        return { problem: 'not-found' }
      },
      async report() {
        throw new Error('dialog exploded')
      },
    }
    const svc = new WorkspaceMainService(
      makeStorage(),
      makeRecents(),
      makeDialog(),
      undefined,
      undefined,
      guard,
    )

    await expect(svc.openFolder(URI.file('/tmp/gone'))).resolves.toBeUndefined()
    expect(svc.current).toBeNull()
    svc.dispose()
  })

  it('openFolder still resolves when removing the dead recent entry rejects', async () => {
    const recents = makeRecents()
    recents.remove = () => Promise.reject(new Error('persist failed'))
    const { guard, reports } = makeGuard({ problem: 'not-found' })
    const svc = new WorkspaceMainService(
      makeStorage(),
      recents,
      makeDialog(),
      undefined,
      undefined,
      guard,
    )

    await expect(svc.openFolder(URI.file('/tmp/gone'))).resolves.toBeUndefined()
    expect(reports).toHaveLength(1)
    svc.dispose()
  })

  it('clearRecent delegates to the shared recent service', async () => {
    const recents = makeRecents()
    const svc = new WorkspaceMainService(makeStorage(), recents, makeDialog())
    await svc.openFolder(URI.file('/tmp/x'))
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    await svc.clearRecent()
    await expect(svc.getRecent()).resolves.toEqual([])
    svc.dispose()
  })

  it('removeRecent delegates to the shared recent service', async () => {
    const recents = makeRecents()
    const svc = new WorkspaceMainService(makeStorage(), recents, makeDialog())
    const a = URI.file('/tmp/a')
    const b = URI.file('/tmp/b')
    await svc.openFolder(a)
    await svc.openFolder(b)
    await expect(svc.getRecent()).resolves.toHaveLength(2)
    await svc.removeRecent(b)
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([a.toString()])
    svc.dispose()
  })

  it('closeFolder clears current but leaves recent intact', async () => {
    const svc = new WorkspaceMainService(makeStorage(), makeRecents(), makeDialog())
    await svc.openFolder(URI.file('/tmp/x'))
    await svc.closeFolder()
    await expect(svc.getCurrent()).resolves.toBeNull()
    await expect(svc.getRecent()).resolves.toHaveLength(1)
    svc.dispose()
  })

  it('relays recent changes from the shared recent service', async () => {
    const recents = makeRecents()
    const svc = new WorkspaceMainService(makeStorage(), recents, makeDialog())
    const events: number[] = []
    svc.onDidChangeRecent((r) => events.push(r.length))
    // Mutating the shared service directly should reach the relayed event.
    await recents.add({ folder: URI.file('/tmp/shared'), name: 'shared' })
    expect(events).toEqual([1])
    svc.dispose()
  })

  it('restoreCurrent fires onDidChangeWorkspace, binds scope, marks hydrated, and bumps recent', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
    const recentEvents: (IRecentWorkspace[] | null)[] = []
    svc.onDidChangeRecent((r) => recentEvents.push(r as IRecentWorkspace[]))
    const restoreSpy = vi.fn()
    svc.onDidChangeWorkspace(restoreSpy)

    const folder = URI.file('/tmp/r')
    await svc.restoreCurrent({ folder, name: 'r' })
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(recentEvents).toEqual([[expect.objectContaining({ name: 'r' })]])
    expect((await svc.getCurrent())?.folder.toString()).toBe(folder.toString())
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([folder.toString()])
    // scope bound exactly once by restoreCurrent; getCurrent must not re-switch
    expect(storage.switchCalls).toHaveLength(1)
    expect(storage.switchCalls[0]).toBeTypeOf('string')
    svc.dispose()
  })

  it('empty window: getCurrent() is null and detaches the WORKSPACE scope', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
    await expect(svc.getCurrent()).resolves.toBeNull()
    expect(storage.switchCalls.at(-1)).toBeNull()
    svc.dispose()
  })

  it('openFolder focuses an existing window, bumps recent, and aborts when the interceptor returns true', async () => {
    const storage = makeStorage()
    const seen: string[] = []
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog(), undefined, (id) => {
      seen.push(id)
      return true
    })
    const workspaceEvents: unknown[] = []
    svc.onDidChangeWorkspace((w) => workspaceEvents.push(w))
    await svc.openFolder(URI.file('/tmp/already-open'))
    expect(seen).toHaveLength(1)
    // aborted: no current set, no workspace event fired, no scope swap to a real id
    await expect(svc.getCurrent()).resolves.toBeNull()
    expect(workspaceEvents).toEqual([])
    // still counts as "opened" for recency purposes
    const recent = await svc.getRecent()
    expect(recent.map((r) => r.folder.toString())).toEqual([
      URI.file('/tmp/already-open').toString(),
    ])
    svc.dispose()
  })

  it('openFolder flushes storage and switches scope before firing onDidChangeWorkspace', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
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
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
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

  it('openFolder proceeds when the outgoing workspace flush rejects', async () => {
    // Regression: the outgoing workspace's atomic write can reject (e.g. its
    // .tmp was deleted out from under it). A bare `await flush()` used to bubble
    // that rejection out of openFolder; it must be best-effort so the swap still
    // happens (mirrors switchWorkspace's own try/catch flush).
    const storage = makeStorage()
    storage.flush = () => Promise.reject(new Error('ENOENT: rename tmp'))
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
    let fired = false
    svc.onDidChangeWorkspace(() => (fired = true))
    await expect(svc.openFolder(URI.file('/tmp/foo'))).resolves.toBeUndefined()
    expect(storage.switchCalls.at(-1)).toBeTypeOf('string')
    expect(fired).toBe(true)
    svc.dispose()
  })

  it('closeFolder proceeds when the outgoing workspace flush rejects', async () => {
    const storage = makeStorage()
    const svc = new WorkspaceMainService(storage, makeRecents(), makeDialog())
    await svc.openFolder(URI.file('/tmp/foo'))
    storage.flush = () => Promise.reject(new Error('ENOENT: rename tmp'))
    storage.switchCalls.length = 0
    let scopeAtFire: (string | null)[] = []
    svc.onDidChangeWorkspace(() => {
      scopeAtFire = [...storage.switchCalls]
    })
    await expect(svc.closeFolder()).resolves.toBeUndefined()
    expect(scopeAtFire.at(-1)).toBeNull()
    svc.dispose()
  })
})
