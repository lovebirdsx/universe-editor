/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionHistory.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  URI,
  type ILogger,
  type ILoggerService,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  readonly setCalls: Array<{ key: string; value: unknown; scope: StorageScope }> = []
  readonly removeCalls: Array<{ key: string; scope: StorageScope }> = []
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
    this.removeCalls.push({ key, scope })
  }
  fireWorkspaceScopeChange(): void {
    this._onDidChangeWorkspaceScope.fire()
  }
  /** Convenience for asserting against the legacy "single store" shape. */
  get store(): Map<string, unknown> {
    return this.buckets.get(StorageScope.WORKSPACE)!
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  private _current: IWorkspace | null
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  constructor(initial: IWorkspace | null = makeFakeWorkspace('/work')) {
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
}

function makeFakeWorkspace(path: string): IWorkspace {
  return { folder: URI.file(path), name: path }
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

interface MakeOptions {
  storage?: FakeStorage
  workspace?: FakeWorkspaceService
}

function makeService(opts: MakeOptions = {}): {
  svc: AcpSessionHistoryService
  storage: FakeStorage
  workspace: FakeWorkspaceService
} {
  const storage = opts.storage ?? new FakeStorage()
  const workspace = opts.workspace ?? new FakeWorkspaceService()
  const svc = new AcpSessionHistoryService(
    storage,
    workspace,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return { svc, storage, workspace }
}

/** Drain the 100ms debounce + the async set() microtask. */
async function flushWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpSessionHistoryService — add / list', () => {
  let svc: AcpSessionHistoryService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('add prepends a new entry and stamps ids + timestamps', async () => {
    await svc.initialize()
    const before = Date.now()
    const entry = svc.add({
      agentId: 'fake',
      sessionIdOnAgent: 'agent-1',
      title: 'Test',
      cwd: '/work',
    })
    const after = Date.now()
    expect(entry.id).toMatch(/^h\d+-/)
    expect(entry.createdAt).toBeGreaterThanOrEqual(before)
    expect(entry.createdAt).toBeLessThanOrEqual(after)
    expect(entry.lastUsedAt).toBe(entry.createdAt)
    expect(svc.list()).toHaveLength(1)
    expect(svc.list()[0]).toBe(entry)
  })

  it('add replaces the prior row when (agentId, sessionIdOnAgent) collides — keeps createdAt', async () => {
    await svc.initialize()
    const first = svc.add({ agentId: 'fake', sessionIdOnAgent: 'a', title: 'v1' })
    // Force timestamp drift so the assertion on lastUsedAt is meaningful.
    await new Promise((r) => setTimeout(r, 5))
    const second = svc.add({ agentId: 'fake', sessionIdOnAgent: 'a', title: 'v2' })
    expect(svc.list()).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.lastUsedAt).toBeGreaterThan(first.lastUsedAt)
    expect(svc.list()[0]?.title).toBe('v2')
  })

  it('list orders most-recently-added first', async () => {
    await svc.initialize()
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'one' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '2', title: 'two' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '3', title: 'three' })
    expect(svc.list().map((e) => e.title)).toEqual(['three', 'two', 'one'])
  })

  it('add omits cwd field when not provided (exactOptionalPropertyTypes)', async () => {
    await svc.initialize()
    const entry = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    expect('cwd' in entry).toBe(false)
  })

  it('truncates to the 100-entry LRU ceiling', async () => {
    await svc.initialize()
    for (let i = 0; i < 105; i++) {
      svc.add({ agentId: 'a', sessionIdOnAgent: `s${i}`, title: `t${i}` })
    }
    expect(svc.list()).toHaveLength(100)
    // The most-recently-added (s104) must be first; the oldest five must be dropped.
    expect(svc.list()[0]?.sessionIdOnAgent).toBe('s104')
    expect(svc.list().some((e) => e.sessionIdOnAgent === 's0')).toBe(false)
  })

  it('publishes to the entries observable', async () => {
    await svc.initialize()
    expect(svc.entries.get()).toEqual([])
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    expect(svc.entries.get()).toHaveLength(1)
  })
})

describe('AcpSessionHistoryService — touch / remove / clear', () => {
  let svc: AcpSessionHistoryService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('touch bumps lastUsedAt and moves the entry to the head', async () => {
    await svc.initialize()
    const a = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'a' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '2', title: 'b' })
    await new Promise((r) => setTimeout(r, 5))
    svc.touch(a.id)
    expect(svc.list()[0]?.id).toBe(a.id)
    expect(svc.list()[0]?.lastUsedAt).toBeGreaterThan(a.lastUsedAt)
  })

  it('touch is a silent no-op for unknown ids', async () => {
    await svc.initialize()
    svc.touch('nope')
    expect(svc.list()).toEqual([])
  })

  it('remove deletes a single entry', async () => {
    await svc.initialize()
    const a = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'a' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '2', title: 'b' })
    svc.remove(a.id)
    expect(svc.list().map((e) => e.sessionIdOnAgent)).toEqual(['2'])
  })

  it('remove is a no-op for unknown ids', async () => {
    await svc.initialize()
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'a' })
    svc.remove('nope')
    expect(svc.list()).toHaveLength(1)
  })

  it('clear wipes everything', async () => {
    await svc.initialize()
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'a' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '2', title: 'b' })
    svc.clear()
    expect(svc.list()).toEqual([])
  })
})

describe('AcpSessionHistoryService — persistence', () => {
  let svc: AcpSessionHistoryService
  let storage: FakeStorage
  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    storage = made.storage
  })
  afterEach(() => {
    svc.dispose()
  })

  it('writes to storage WORKSPACE scope when a folder is open', async () => {
    await svc.initialize()
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    expect(storage.setCalls.length).toBe(0) // debounced
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
    const call = storage.setCalls[0]!
    expect(call.key).toBe('acp.sessionHistory')
    expect(call.scope).toBe(StorageScope.WORKSPACE)
    const persisted = call.value as { schemaVersion: number; entries: unknown[] }
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.entries).toHaveLength(1)
  })

  it('coalesces a burst of writes into a single set() call', async () => {
    await svc.initialize()
    for (let i = 0; i < 5; i++) {
      svc.add({ agentId: 'a', sessionIdOnAgent: `s${i}`, title: `t${i}` })
    }
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
  })

  it('hydrates from storage on initialize() — sorted by lastUsedAt desc', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'h1-x',
          agentId: 'a',
          sessionIdOnAgent: '1',
          title: 'old',
          createdAt: 1,
          lastUsedAt: 1,
        },
        {
          id: 'h2-x',
          agentId: 'a',
          sessionIdOnAgent: '2',
          title: 'new',
          createdAt: 2,
          lastUsedAt: 10,
        },
      ],
    })
    await svc.initialize()
    expect(svc.list().map((e) => e.title)).toEqual(['new', 'old'])
  })

  it('ignores entries with an unknown schemaVersion (fails closed, empty list)', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 999,
      entries: [
        { id: 'x', agentId: 'a', sessionIdOnAgent: 's', title: 't', createdAt: 1, lastUsedAt: 1 },
      ],
    })
    await svc.initialize()
    expect(svc.list()).toEqual([])
  })

  it('drops malformed entries during hydration but keeps the rest', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        { id: 'ok', agentId: 'a', sessionIdOnAgent: 's', title: 't', createdAt: 1, lastUsedAt: 2 },
        { id: 1 }, // garbage
        null,
      ],
    })
    await svc.initialize()
    expect(svc.list().map((e) => e.id)).toEqual(['ok'])
  })

  it('initialize() is idempotent — second call resolves without re-reading', async () => {
    await svc.initialize()
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'late',
          agentId: 'a',
          sessionIdOnAgent: 's',
          title: 't',
          createdAt: 1,
          lastUsedAt: 2,
        },
      ],
    })
    await svc.initialize()
    expect(svc.list().some((e) => e.id === 'late')).toBe(false)
  })

  it('merges entries added before initialize() finishes with the persisted set', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'persisted',
          agentId: 'a',
          sessionIdOnAgent: 'persisted-s',
          title: 'persisted',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    // Add BEFORE initialize() completes — the early add wins on its own row.
    svc.add({ agentId: 'a', sessionIdOnAgent: 'early-s', title: 'early' })
    await svc.initialize()
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toContain('early-s')
    expect(ids).toContain('persisted-s')
  })

  it('migrates v1 entries forward (no configOptions field) without dropping them', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'h1-old',
          agentId: 'a',
          sessionIdOnAgent: 'old',
          title: 'old-v1',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    await svc.initialize()
    expect(svc.list().map((e) => e.title)).toEqual(['old-v1'])
    // First write after migration should write v2.
    svc.add({ agentId: 'a', sessionIdOnAgent: 'new', title: 'new-v2' })
    await flushWrite()
    const lastCall = storage.setCalls[storage.setCalls.length - 1]!
    expect((lastCall.value as { schemaVersion: number }).schemaVersion).toBe(2)
  })

  it('loads v2 entries that carry configOptions verbatim', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 2,
      entries: [
        {
          id: 'h1-v2',
          agentId: 'a',
          sessionIdOnAgent: 'with-opts',
          title: 'has opts',
          createdAt: 1,
          lastUsedAt: 1,
          configOptions: { model: 'claude-sonnet-4-6', thought_level: 'high' },
        },
      ],
    })
    await svc.initialize()
    const entry = svc.list()[0]
    expect(entry?.configOptions).toEqual({
      model: 'claude-sonnet-4-6',
      thought_level: 'high',
    })
  })

  it('rejects v2 entries whose configOptions has non-string values', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 2,
      entries: [
        {
          id: 'bad',
          agentId: 'a',
          sessionIdOnAgent: 'x',
          title: 't',
          createdAt: 1,
          lastUsedAt: 1,
          configOptions: { model: 123 },
        },
        {
          id: 'good',
          agentId: 'a',
          sessionIdOnAgent: 'y',
          title: 't2',
          createdAt: 1,
          lastUsedAt: 2,
        },
      ],
    })
    await svc.initialize()
    expect(svc.list().map((e) => e.id)).toEqual(['good'])
  })
})

describe('AcpSessionHistoryService — setHistoryConfigOption', () => {
  let svc: AcpSessionHistoryService
  let storage: FakeStorage
  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    storage = made.storage
  })
  afterEach(() => {
    svc.dispose()
  })

  it('sets a fresh configOption on an entry with none', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'claude-sonnet-4-6')
    expect(svc.get(e.id)?.configOptions).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('merges into existing configOptions, preserving siblings', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'A')
    svc.setHistoryConfigOption(e.id, 'thought_level', 'high')
    expect(svc.get(e.id)?.configOptions).toEqual({ model: 'A', thought_level: 'high' })
  })

  it('overwrites the same key without duplicating it', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'A')
    svc.setHistoryConfigOption(e.id, 'model', 'B')
    expect(svc.get(e.id)?.configOptions).toEqual({ model: 'B' })
  })

  it('is a no-op for unknown ids', async () => {
    await svc.initialize()
    svc.setHistoryConfigOption('nope', 'model', 'A')
    expect(svc.list()).toEqual([])
  })

  it('skips the write when value is unchanged', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    await flushWrite()
    const before = storage.setCalls.length
    svc.setHistoryConfigOption(e.id, 'model', 'A')
    await flushWrite()
    expect(storage.setCalls.length).toBe(before + 1)
    // Same value again — no new write.
    svc.setHistoryConfigOption(e.id, 'model', 'A')
    await flushWrite()
    expect(storage.setCalls.length).toBe(before + 1)
  })

  it('preserves a configOptions cache when add() re-inserts the same session', async () => {
    await svc.initialize()
    const first = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't1' })
    svc.setHistoryConfigOption(first.id, 'model', 'A')
    // Re-add the same (agentId, sessionIdOnAgent) without configOptions — should
    // preserve the cache. This mirrors the touch path used by resumeSession.
    const second = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't2' })
    expect(second.configOptions).toEqual({ model: 'A' })
  })
})

describe('AcpSessionHistoryService — workspace scope', () => {
  it('with a workspace open: writes go to WORKSPACE bucket', async () => {
    const storage = new FakeStorage()
    const workspace = new FakeWorkspaceService(makeFakeWorkspace('/work-a'))
    const { svc } = makeService({ storage, workspace })
    try {
      await svc.initialize()
      svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
      await flushWrite()
      expect(storage.setCalls.at(-1)?.scope).toBe(StorageScope.WORKSPACE)
    } finally {
      svc.dispose()
    }
  })

  it('with no workspace: falls back to GLOBAL bucket once the scope event fires', async () => {
    const storage = new FakeStorage()
    const workspace = new FakeWorkspaceService(null)
    const { svc } = makeService({ storage, workspace })
    try {
      const initPromise = svc.initialize()
      // Fire the scope event so _scheduleInitialLoad resolves without waiting the 500ms timeout.
      storage.fireWorkspaceScopeChange()
      await initPromise
      svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
      await flushWrite()
      const call = storage.setCalls.at(-1)
      expect(call?.scope).toBe(StorageScope.GLOBAL)
    } finally {
      svc.dispose()
    }
  })

  it('workspace swap: clears in-memory entries and reloads from the new bucket', async () => {
    const storage = new FakeStorage()
    // Pre-seed both buckets with distinct data so we can tell them apart.
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 2,
      entries: [
        {
          id: 'a-only',
          agentId: 'a',
          sessionIdOnAgent: 'sa',
          title: 'from-A',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    const workspace = new FakeWorkspaceService(makeFakeWorkspace('/work-a'))
    const { svc } = makeService({ storage, workspace })
    try {
      await svc.initialize()
      expect(svc.list().map((e) => e.title)).toEqual(['from-A'])

      // Simulate workspace B swap: storage swaps the WORKSPACE bucket atomically,
      // and fires onDidChangeWorkspaceScope.
      storage.buckets.get(StorageScope.WORKSPACE)!.clear()
      storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
        schemaVersion: 2,
        entries: [
          {
            id: 'b-only',
            agentId: 'b',
            sessionIdOnAgent: 'sb',
            title: 'from-B',
            createdAt: 1,
            lastUsedAt: 1,
          },
        ],
      })
      storage.fireWorkspaceScopeChange()
      // Wait for the async _reload to finish.
      await new Promise((r) => setTimeout(r, 20))
      expect(svc.list().map((e) => e.title)).toEqual(['from-B'])
    } finally {
      svc.dispose()
    }
  })

  it('write scheduled during _reload does not leak into the new bucket', async () => {
    const storage = new FakeStorage()
    const workspace = new FakeWorkspaceService(makeFakeWorkspace('/work-a'))
    const { svc } = makeService({ storage, workspace })
    try {
      await svc.initialize()
      svc.add({ agentId: 'a', sessionIdOnAgent: 'sa', title: 'from-A' })
      await flushWrite()
      const writesBefore = storage.setCalls.length

      // Trigger reload but DON'T await it; in the same tick try to add()
      // — _writeSuspended should make the add() a silent no-op for the write timer.
      const reloadPromise = (async () => {
        storage.fireWorkspaceScopeChange()
        await new Promise((r) => setTimeout(r, 20))
      })()
      svc.add({ agentId: 'a', sessionIdOnAgent: 'sa-during', title: 'should-be-suspended' })
      await reloadPromise

      // After reload completes, the suspended write should have been dropped
      // (no new setCall recorded between writesBefore and now).
      const newCalls = storage.setCalls.slice(writesBefore)
      // The only acceptable new call is the flush of pending OLD-scope state
      // performed by _reload itself, which by design targets the OLD WORKSPACE.
      for (const c of newCalls) {
        expect(c.scope).toBe(StorageScope.WORKSPACE)
      }
    } finally {
      svc.dispose()
    }
  })
})
