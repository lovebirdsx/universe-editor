/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/mcpServerEnablementService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NullLogger,
  StorageScope,
  URI,
  type ILogger,
  type ILoggerService,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { McpServerEnablementService } from '../mcpServerEnablementService.js'

const STORAGE_KEY = 'acp.mcpServerEnablement'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  readonly setCalls: Array<{ key: string; value: unknown; scope: StorageScope }> = []
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  async get<T = unknown>(
    key: string,
    scope: StorageScope = StorageScope.GLOBAL,
  ): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.set(key, value)
    this.setCalls.push({ key, value, scope })
  }
  async remove(key: string, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
  fireWorkspaceScopeChange(): void {
    this._onDidChangeWorkspaceScope.fire()
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  private _current: IWorkspace | null
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(initial: IWorkspace | null = null) {
    this._current = initial
  }
  get current(): IWorkspace | null {
    return this._current
  }
  setCurrent(w: IWorkspace | null): void {
    this._current = w
  }
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async clearRecent(): Promise<void> {}
  async removeRecent(): Promise<void> {}
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function makeWorkspace(path = '/work'): IWorkspace {
  return { folder: URI.file(path), name: path }
}

describe('McpServerEnablementService', () => {
  let storage: FakeStorage
  let workspace: FakeWorkspaceService

  beforeEach(() => {
    storage = new FakeStorage()
    workspace = new FakeWorkspaceService(makeWorkspace())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeService(): McpServerEnablementService {
    return new McpServerEnablementService(storage, workspace, new StubLoggerService())
  }

  describe('cold start', () => {
    it('reads both scopes immediately when a workspace is already open', async () => {
      storage.buckets.get(StorageScope.GLOBAL)!.set(STORAGE_KEY, { a: false })
      storage.buckets.get(StorageScope.WORKSPACE)!.set(STORAGE_KEY, { b: false })
      const svc = makeService()
      await svc.whenReady
      expect(svc.isEnabled('a')).toBe(false)
      expect(svc.isEnabled('b')).toBe(false)
      expect(svc.isEnabled('c')).toBe(true)
    })

    it('waits for the first workspace-scope event before reading the workspace bucket', async () => {
      workspace.setCurrent(null)
      storage.buckets.get(StorageScope.WORKSPACE)!.set(STORAGE_KEY, { b: false })
      const svc = makeService()
      // Simulate main-side hydration completing: current flips, then the event fires.
      workspace.setCurrent(makeWorkspace())
      storage.fireWorkspaceScopeChange()
      await svc.whenReady
      expect(svc.isEnabled('b')).toBe(false)
    })

    it('settles on the empty-window timeout and stays global-only', async () => {
      vi.useFakeTimers()
      workspace.setCurrent(null)
      storage.buckets.get(StorageScope.GLOBAL)!.set(STORAGE_KEY, { a: false })
      storage.buckets.get(StorageScope.WORKSPACE)!.set(STORAGE_KEY, { b: false })
      const svc = makeService()
      await vi.advanceTimersByTimeAsync(500)
      await svc.whenReady
      expect(svc.isEnabled('a')).toBe(false)
      // No workspace → the workspace bucket is never consulted.
      expect(svc.isEnabled('b')).toBe(true)
    })

    it('ignores malformed stored values', async () => {
      storage.buckets.get(StorageScope.GLOBAL)!.set(STORAGE_KEY, ['not', 'a', 'record'])
      storage.buckets.get(StorageScope.WORKSPACE)!.set(STORAGE_KEY, { a: 'yes', b: false })
      const svc = makeService()
      await svc.whenReady
      expect(svc.isEnabled('a')).toBe(true)
      expect(svc.isEnabled('b')).toBe(false)
    })
  })

  describe('resolution precedence', () => {
    it('workspace override wins over global in both directions', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', false, StorageScope.GLOBAL)
      expect(svc.isEnabled('a')).toBe(false)
      await svc.setEnabled('a', true, StorageScope.WORKSPACE)
      expect(svc.isEnabled('a')).toBe(true)
      await svc.setEnabled('b', true, StorageScope.GLOBAL)
      await svc.setEnabled('b', false, StorageScope.WORKSPACE)
      expect(svc.isEnabled('b')).toBe(false)
    })

    it('getOverride reports the per-scope record without falling back', async () => {
      const svc = makeService()
      await svc.whenReady
      expect(svc.getOverride('a', StorageScope.GLOBAL)).toBeUndefined()
      expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
      await svc.setEnabled('a', false, StorageScope.GLOBAL)
      expect(svc.getOverride('a', StorageScope.GLOBAL)).toBe(false)
      expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
    })
  })

  describe('setEnabled', () => {
    it('flips the cache synchronously, fires, and persists the whole record', async () => {
      const svc = makeService()
      await svc.whenReady
      let fired = 0
      svc.onDidChange(() => fired++)
      const before = fired
      const write = svc.setEnabled('a', false, StorageScope.GLOBAL)
      // Cache is synchronous: observable state flips before the write resolves.
      expect(svc.isEnabled('a')).toBe(false)
      expect(fired).toBe(before + 1)
      await write
      expect(storage.setCalls).toHaveLength(1)
      expect(storage.setCalls[0]).toEqual({
        key: STORAGE_KEY,
        value: { a: false },
        scope: StorageScope.GLOBAL,
      })
    })

    it('stores explicit true records instead of deleting the key', async () => {
      const svc = makeService()
      await svc.whenReady
      // A workspace-level disable must NOT turn a later user-level enable into
      // a no-op: the GLOBAL record has to exist to keep the row's stance.
      await svc.setEnabled('a', false, StorageScope.WORKSPACE)
      await svc.setEnabled('a', true, StorageScope.GLOBAL)
      expect(storage.buckets.get(StorageScope.GLOBAL)!.get(STORAGE_KEY)).toEqual({ a: true })
      expect(svc.getOverride('a', StorageScope.GLOBAL)).toBe(true)
      expect(svc.isEnabled('a')).toBe(false) // workspace still wins
    })

    it('is a no-op when the value is unchanged', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', false, StorageScope.GLOBAL)
      storage.setCalls.length = 0
      let fired = 0
      svc.onDidChange(() => fired++)
      await svc.setEnabled('a', false, StorageScope.GLOBAL)
      expect(fired).toBe(0)
      expect(storage.setCalls).toHaveLength(0)
    })

    it('refuses WORKSPACE writes without an open workspace', async () => {
      const svc = makeService()
      await svc.whenReady
      workspace.setCurrent(null)
      let fired = 0
      svc.onDidChange(() => fired++)
      await svc.setEnabled('a', false, StorageScope.WORKSPACE)
      expect(fired).toBe(0)
      expect(storage.setCalls).toHaveLength(0)
      expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
    })
  })

  describe('workspace swap', () => {
    it('re-reads the new bucket and drops the old overrides', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', false, StorageScope.WORKSPACE)
      expect(svc.isEnabled('a')).toBe(false)
      // Swap: new bucket has its own records.
      storage.buckets.set(StorageScope.WORKSPACE, new Map([[STORAGE_KEY, { b: false }]]))
      let fired = 0
      svc.onDidChange(() => fired++)
      storage.fireWorkspaceScopeChange()
      await vi.waitFor(() => {
        expect(svc.getOverride('b', StorageScope.WORKSPACE)).toBe(false)
      })
      expect(fired).toBeGreaterThan(0)
      expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
      expect(svc.isEnabled('a')).toBe(true)
    })

    it('clears workspace overrides when the folder is closed', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', false, StorageScope.WORKSPACE)
      workspace.setCurrent(null)
      storage.fireWorkspaceScopeChange()
      await vi.waitFor(() => {
        expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
      })
      expect(svc.isEnabled('a')).toBe(true)
    })
  })

  describe('removeOverride', () => {
    it('drops the record, fires, persists, and falls back to the lower scope', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', false, StorageScope.GLOBAL)
      await svc.setEnabled('a', true, StorageScope.WORKSPACE)
      expect(svc.isEnabled('a')).toBe(true)

      let fired = 0
      svc.onDidChange(() => fired++)
      await svc.removeOverride('a', StorageScope.WORKSPACE)
      expect(fired).toBe(1)
      expect(svc.getOverride('a', StorageScope.WORKSPACE)).toBeUndefined()
      // Falls back to the GLOBAL override.
      expect(svc.isEnabled('a')).toBe(false)
      expect(storage.buckets.get(StorageScope.WORKSPACE)!.get(STORAGE_KEY)).toEqual({})
    })

    it('is a no-op when no override is recorded', async () => {
      const svc = makeService()
      await svc.whenReady
      let fired = 0
      svc.onDidChange(() => fired++)
      await svc.removeOverride('a', StorageScope.WORKSPACE)
      expect(fired).toBe(0)
      expect(storage.setCalls).toHaveLength(0)
    })

    it('keeps the workspace override when the global record is removed', async () => {
      const svc = makeService()
      await svc.whenReady
      await svc.setEnabled('a', true, StorageScope.GLOBAL)
      await svc.setEnabled('a', false, StorageScope.WORKSPACE)
      await svc.removeOverride('a', StorageScope.GLOBAL)
      expect(svc.getOverride('a', StorageScope.GLOBAL)).toBeUndefined()
      expect(svc.isEnabled('a')).toBe(false)
    })
  })

  it('persists across instances (restart)', async () => {
    const first = makeService()
    await first.whenReady
    await first.setEnabled('a', false, StorageScope.GLOBAL)
    await first.setEnabled('b', false, StorageScope.WORKSPACE)
    const second = makeService()
    await second.whenReady
    expect(second.isEnabled('a')).toBe(false)
    expect(second.isEnabled('b')).toBe(false)
  })
})
