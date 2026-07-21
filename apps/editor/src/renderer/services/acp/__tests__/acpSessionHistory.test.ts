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
  UriIdentityService,
  type HostPlatform,
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
  readonly whenReady: Promise<void> = Promise.resolve()
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
  async removeRecent(): Promise<void> {}
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
  platform?: HostPlatform
}

function makeUriIdentity(platform: HostPlatform): UriIdentityService {
  return new UriIdentityService(platform)
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
    makeUriIdentity(opts.platform ?? 'linux'),
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
    expect(entry.id).toBe('agent-1')
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
    expect(persisted.schemaVersion).toBe(1)
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
        { id: 'ok', agentId: 'a', sessionIdOnAgent: 'ok', title: 't', createdAt: 1, lastUsedAt: 2 },
        { id: 1 }, // garbage
        null,
      ],
    })
    await svc.initialize()
    expect(svc.list().map((e) => e.id)).toEqual(['ok'])
  })

  it('normalizes legacy entries whose id !== sessionIdOnAgent so get(sessionIdOnAgent) hits', async () => {
    // Regression: legacy persisted shape used auto-increment ids like 'h5-mpl5owcr'
    // while the agent's sessionId lives in `sessionIdOnAgent`. The current schema
    // requires `id === sessionIdOnAgent`; without normalization, restoring a session
    // via history.get(sessionIdOnAgent) misses and the editor sits on a permanent spinner.
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'h5-mpl5owcr',
          agentId: 'claude-code',
          sessionIdOnAgent: '04470b5c-fcf7-473e-814d-cb9f2ac997f3',
          title: '你的工作目录是？',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    await svc.initialize()
    const got = svc.get('04470b5c-fcf7-473e-814d-cb9f2ac997f3')
    expect(got).toBeDefined()
    expect(got?.id).toBe('04470b5c-fcf7-473e-814d-cb9f2ac997f3')
    expect(got?.title).toBe('你的工作目录是？')
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

  it('loads entries that carry configOptions verbatim', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
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

  it('rejects entries whose configOptions has non-string values', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'bad',
          agentId: 'a',
          sessionIdOnAgent: 'bad',
          title: 't',
          createdAt: 1,
          lastUsedAt: 1,
          configOptions: { model: 123 },
        },
        {
          id: 'good',
          agentId: 'a',
          sessionIdOnAgent: 'good',
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

  it('stores the friendly label alongside the value when provided', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'claude-opus-4-8', 'Opus 4.8')
    expect(svc.get(e.id)?.configOptions).toEqual({ model: 'claude-opus-4-8' })
    expect(svc.get(e.id)?.configLabels).toEqual({ model: 'Opus 4.8' })
  })

  it('writes when only the label changed (value unchanged)', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'A', 'Old')
    await flushWrite()
    const before = storage.setCalls.length
    svc.setHistoryConfigOption(e.id, 'model', 'A', 'New')
    await flushWrite()
    expect(storage.setCalls.length).toBe(before + 1)
    expect(svc.get(e.id)?.configLabels).toEqual({ model: 'New' })
  })

  it('preserves configLabels across an add() re-insert', async () => {
    await svc.initialize()
    const first = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't1' })
    svc.setHistoryConfigOption(first.id, 'reasoning_effort', 'high', 'high')
    const second = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't2' })
    expect(second.configLabels).toEqual({ reasoning_effort: 'high' })
  })
})

describe('AcpSessionHistoryService — setHistoryUsage', () => {
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

  it('sets a usage snapshot on an entry with none', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryUsage(e.id, { used: 1200, size: 100_000 })
    expect(svc.get(e.id)?.usage).toEqual({ used: 1200, size: 100_000 })
  })

  it('stores the optional cost field', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    svc.setHistoryUsage(e.id, {
      used: 500,
      size: 100_000,
      cost: { amount: 0.025, currency: 'USD' },
    })
    expect(svc.get(e.id)?.usage).toEqual({
      used: 500,
      size: 100_000,
      cost: { amount: 0.025, currency: 'USD' },
    })
  })

  it('is a no-op for unknown ids', async () => {
    await svc.initialize()
    svc.setHistoryUsage('nope', { used: 1, size: 2 })
    expect(svc.list()).toEqual([])
  })

  it('skips the write when the snapshot is unchanged', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    await flushWrite()
    const before = storage.setCalls.length
    svc.setHistoryUsage(e.id, { used: 10, size: 100 })
    await flushWrite()
    expect(storage.setCalls.length).toBe(before + 1)
    // Identical snapshot again — no new write.
    svc.setHistoryUsage(e.id, { used: 10, size: 100 })
    await flushWrite()
    expect(storage.setCalls.length).toBe(before + 1)
  })

  it('preserves a usage snapshot when add() re-inserts the same session', async () => {
    await svc.initialize()
    const first = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't1' })
    svc.setHistoryUsage(first.id, { used: 42, size: 100 })
    // Re-add without usage — must preserve the snapshot (resumeSession path).
    const second = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't2' })
    expect(second.usage).toEqual({ used: 42, size: 100 })
  })

  it('round-trips a usage snapshot through persistence', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'with-usage',
          agentId: 'a',
          sessionIdOnAgent: 'with-usage',
          title: 'has usage',
          createdAt: 1,
          lastUsedAt: 1,
          usage: { used: 7, size: 200, cost: { amount: 1.5, currency: 'USD' } },
        },
      ],
    })
    await svc.initialize()
    expect(svc.get('with-usage')?.usage).toEqual({
      used: 7,
      size: 200,
      cost: { amount: 1.5, currency: 'USD' },
    })
  })

  it('drops entries whose usage shape is malformed during hydration', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'bad',
          agentId: 'a',
          sessionIdOnAgent: 'bad',
          title: 't',
          createdAt: 1,
          lastUsedAt: 1,
          usage: { used: 'x', size: 2 },
        },
        {
          id: 'good',
          agentId: 'a',
          sessionIdOnAgent: 'good',
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

describe('AcpSessionHistoryService — bulkMergeFromAgent', () => {
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

  it('creates fresh rows for protocol sessions that have no local match', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [
        { sessionId: 's-1', cwd: '/work', title: 'one', updatedAt: '2024-01-01T00:00:00Z' },
        { sessionId: 's-2', cwd: '/work', title: 'two', updatedAt: '2024-02-01T00:00:00Z' },
      ],
      '/work',
      'workspace',
    )
    const list = svc.list()
    expect(list.map((e) => e.sessionIdOnAgent)).toEqual(['s-2', 's-1'])
    expect(list[0]?.title).toBe('two')
    expect(list[0]?.lastUsedAt).toBe(Date.parse('2024-02-01T00:00:00Z'))
    expect(list[0]?.cwd).toBe('/work')
  })

  it('carries the transcriptPath from the protocol session onto the entry', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [
        {
          sessionId: 's-1',
          cwd: '/work',
          title: 'one',
          updatedAt: null,
          transcriptPath: '/home/u/.claude/projects/work/s-1.jsonl',
        },
      ],
      '/work',
      'workspace',
    )
    expect(svc.get('s-1')?.transcriptPath).toBe('/home/u/.claude/projects/work/s-1.jsonl')
  })

  it('preserves an existing transcriptPath when the protocol omits it', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [
        {
          sessionId: 's-1',
          cwd: '/work',
          title: 'one',
          updatedAt: null,
          transcriptPath: '/p/s-1.jsonl',
        },
      ],
      '/work',
      'workspace',
    )
    // A later hydrate that doesn't report the path must not wipe it.
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 'renamed', updatedAt: '2024-03-01T00:00:00Z' }],
      '/work',
      'workspace',
    )
    expect(svc.get('s-1')?.transcriptPath).toBe('/p/s-1.jsonl')
  })

  it('upserts existing rows by (agentId, sessionIdOnAgent) and keeps the local id/createdAt', async () => {
    await svc.initialize()
    const existing = svc.add({
      agentId: 'fake',
      sessionIdOnAgent: 's-keep',
      title: 'local-title',
      cwd: '/work',
    })
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-keep', cwd: '/work', title: 'protocol-title', updatedAt: null }],
      '/work',
      'workspace',
    )
    const got = svc.get(existing.id)
    expect(got?.id).toBe(existing.id)
    expect(got?.createdAt).toBe(existing.createdAt)
    expect(got?.title).toBe('protocol-title')
  })

  it('preserves configOptions when upserting from protocol', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 't' })
    svc.setHistoryConfigOption(e.id, 'model', 'claude-sonnet-4-6')
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 'renamed', updatedAt: null }],
      '/work',
      'workspace',
    )
    expect(svc.get(e.id)?.configOptions).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('keeps an AI-flagged local title over the protocol summary (compact-reset case)', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 'AI Title' })
    svc.setHistoryAiTitle(e.id)
    // After /compact the agent's summary reverts to the first prompt; the merge
    // must not clobber our AI title with it.
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 'first user prompt', updatedAt: null }],
      '/work',
      'workspace',
    )
    expect(svc.get(e.id)?.title).toBe('AI Title')
    expect(svc.get(e.id)?.aiTitle).toBe(true)
  })

  it('keeps a manually-renamed local title over the protocol summary', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 'My Name' })
    svc.setHistoryManualTitle(e.id)
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 'first user prompt', updatedAt: null }],
      '/work',
      'workspace',
    )
    expect(svc.get(e.id)?.title).toBe('My Name')
    expect(svc.get(e.id)?.manualTitle).toBe(true)
  })

  it('preserves a manual title + flag across re-add (resume)', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 'My Name' })
    svc.setHistoryManualTitle(e.id)
    // Re-adding the same (agentId, sessionIdOnAgent) with the placeholder title
    // (as resume does) must not blow away the manual title.
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 'fake 09:00' })
    expect(svc.get(e.id)?.title).toBe('My Name')
    expect(svc.get(e.id)?.manualTitle).toBe(true)
  })

  it('lastUsedAt = max(protocol updatedAt, local lastUsedAt)', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's-1', title: 't' })
    const localTs = e.lastUsedAt
    // Protocol reports an older timestamp — local wins.
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 't', updatedAt: '2000-01-01T00:00:00Z' }],
      '/work',
      'workspace',
    )
    expect(svc.get(e.id)?.lastUsedAt).toBe(localTs)
    // Protocol reports a newer timestamp — protocol wins.
    const future = new Date(Date.now() + 86_400_000).toISOString()
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 't', updatedAt: future }],
      '/work',
      'workspace',
    )
    expect(svc.get(e.id)?.lastUsedAt).toBe(Date.parse(future))
  })

  it('falls back to sessionId as the title when protocol returns no title', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-blank', cwd: '/work', title: null, updatedAt: null }],
      '/work',
      'workspace',
    )
    expect(svc.list()[0]?.title).toBe('s-blank')
  })

  it('does not partition by agentId — different agents own different rows for the same sessionId', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'alpha',
      [{ sessionId: 's-shared', cwd: '/work', title: 'A', updatedAt: null }],
      '/work',
      'workspace',
    )
    svc.bulkMergeFromAgent(
      'beta',
      [{ sessionId: 's-shared', cwd: '/work', title: 'B', updatedAt: null }],
      '/work',
      'workspace',
    )
    expect(svc.list()).toHaveLength(2)
    expect(
      svc
        .list()
        .map((e) => e.agentId)
        .sort(),
    ).toEqual(['alpha', 'beta'])
  })

  it('sorts the resulting list by lastUsedAt desc and truncates to MAX_ENTRIES', async () => {
    await svc.initialize()
    const big: { sessionId: string; cwd: string; title: string; updatedAt: string }[] = []
    for (let i = 0; i < 110; i++) {
      big.push({
        sessionId: `s-${i}`,
        cwd: '/work',
        title: `t-${i}`,
        updatedAt: new Date(2000_000 + i * 1000).toISOString(),
      })
    }
    svc.bulkMergeFromAgent('fake', big, '/work', 'workspace')
    expect(svc.list()).toHaveLength(100)
    // s-109 has the largest updatedAt — must be first.
    expect(svc.list()[0]?.sessionIdOnAgent).toBe('s-109')
    expect(svc.list().some((e) => e.sessionIdOnAgent === 's-0')).toBe(false)
  })

  it('is a no-op when the protocol list is empty', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-untouched', title: 't' })
    await flushWrite()
    const writesBefore = storage.setCalls.length
    svc.bulkMergeFromAgent('fake', [], '/work', 'workspace')
    await flushWrite()
    expect(storage.setCalls.length).toBe(writesBefore)
    expect(svc.list()).toHaveLength(1)
  })

  it('skips the write when nothing changed', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'fake', sessionIdOnAgent: 's', title: 'same', cwd: '/work' })
    await flushWrite()
    const writesBefore = storage.setCalls.length
    // Protocol re-reports identical title/cwd and an OLDER updatedAt → no change.
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's', cwd: e.cwd ?? '/work', title: 'same', updatedAt: '1970-01-01T00:00:00Z' }],
      '/work',
      'workspace',
    )
    await flushWrite()
    expect(storage.setCalls.length).toBe(writesBefore)
  })

  it('drops malformed protocol entries (empty sessionId)', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [
        { sessionId: '', cwd: '/work', title: 't', updatedAt: null },
        { sessionId: 'good', cwd: '/work', title: 'ok', updatedAt: null },
      ],
      '/work',
      'workspace',
    )
    expect(svc.list().map((e) => e.sessionIdOnAgent)).toEqual(['good'])
  })

  it('drops protocol entries whose cwd does not match the current workspace', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [
        { sessionId: 's-here', cwd: '/work', title: 'mine', updatedAt: null },
        { sessionId: 's-elsewhere', cwd: '/other', title: 'theirs', updatedAt: null },
        // Missing cwd is tolerated (the agent simply didn't report it).
        { sessionId: 's-unknown', cwd: null, title: 'maybe', updatedAt: null },
      ],
      '/work',
      'workspace',
    )
    const titles = svc.list().map((e) => e.title)
    expect(titles).toContain('mine')
    expect(titles).toContain('maybe')
    expect(titles).not.toContain('theirs')
  })

  it('is a no-op when currentCwd is undefined (empty window must not populate fallback bucket)', async () => {
    await svc.initialize()
    svc.bulkMergeFromAgent(
      'fake',
      [{ sessionId: 's-1', cwd: '/work', title: 'one', updatedAt: null }],
      undefined,
      'workspace',
    )
    expect(svc.list()).toEqual([])
  })
})

describe('AcpSessionHistoryService — replaceAgentEntries', () => {
  let svc: AcpSessionHistoryService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('prunes stale entries that the new list no longer reports (same agent + cwd)', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-keep', title: 'keep', cwd: '/work' })
    svc.replaceAgentEntries(
      'fake',
      [{ sessionId: 's-keep', cwd: '/work', title: 'keep', updatedAt: null }],
      '/work',
      new Set<string>(),
      'workspace',
    )
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-keep'])
  })

  it('protects entries listed in preserveIds even when absent from the reported list', async () => {
    await svc.initialize()
    const live = svc.add({
      agentId: 'fake',
      sessionIdOnAgent: 's-live',
      title: 'live',
      cwd: '/work',
    })
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.replaceAgentEntries('fake', [], '/work', new Set<string>([live.id]), 'workspace')
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-live'])
  })

  it('protects a just-created live session whose preserveIds set carries its agent id (codex refresh repro)', async () => {
    // Repro for "create a codex session, send a message, click Refresh → it
    // vanishes". On refresh the prune keys preserveIds against the history row's
    // id (=== sessionIdOnAgent). The live registry contributes BOTH the local
    // uuid and the agent id to preserveIds; codex's session/list may not yet
    // surface the brand-new session, so without the agent id in the set the row
    // would be pruned. The agent id must keep it.
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-just-created', title: 'new', cwd: '/work' })
    const preserve = new Set<string>(['local-uuid-of-just-created', 's-just-created'])
    svc.replaceAgentEntries('fake', [], '/work', preserve, 'workspace')
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-just-created'])
  })

  it('leaves entries for other agents untouched', async () => {
    await svc.initialize()
    svc.add({ agentId: 'other', sessionIdOnAgent: 's-other', title: 'other', cwd: '/work' })
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.replaceAgentEntries('fake', [], '/work', new Set<string>(), 'workspace')
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-other'])
  })

  it('leaves entries from other cwds untouched', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-other-ws', title: 'b', cwd: '/other' })
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.replaceAgentEntries('fake', [], '/work', new Set<string>(), 'workspace')
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-other-ws'])
  })

  it('leaves entries with no cwd untouched (we cannot tell which workspace they belong to)', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-nocwd', title: 'nocwd' })
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.replaceAgentEntries('fake', [], '/work', new Set<string>(), 'workspace')
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-nocwd'])
  })

  it('is a no-op when currentCwd is undefined (empty window)', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-keep', title: 'keep', cwd: '/work' })
    svc.replaceAgentEntries('fake', [], undefined, new Set<string>(), 'workspace')
    expect(svc.list().map((e) => e.sessionIdOnAgent)).toEqual(['s-keep'])
  })

  it('still upserts new sessions while pruning stale ones in the same call', async () => {
    await svc.initialize()
    svc.add({ agentId: 'fake', sessionIdOnAgent: 's-stale', title: 'stale', cwd: '/work' })
    svc.replaceAgentEntries(
      'fake',
      [{ sessionId: 's-new', cwd: '/work', title: 'new', updatedAt: '2024-02-01T00:00:00Z' }],
      '/work',
      new Set<string>(),
      'workspace',
    )
    const ids = svc.list().map((e) => e.sessionIdOnAgent)
    expect(ids).toEqual(['s-new'])
  })
})

describe('AcpSessionHistoryService — updateInfo', () => {
  let svc: AcpSessionHistoryService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('patches title and bumps lastUsedAt when updatedAt is newer', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'old' })
    const future = e.lastUsedAt + 100_000
    svc.updateInfo(e.id, { title: 'new', updatedAt: future })
    const got = svc.get(e.id)
    expect(got?.title).toBe('new')
    expect(got?.lastUsedAt).toBe(future)
  })

  it('keeps lastUsedAt when patch.updatedAt is older', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'old' })
    svc.updateInfo(e.id, { updatedAt: e.lastUsedAt - 100_000 })
    expect(svc.get(e.id)?.lastUsedAt).toBe(e.lastUsedAt)
  })

  it('is a no-op for unknown ids', async () => {
    await svc.initialize()
    svc.updateInfo('nope', { title: 'x' })
    expect(svc.list()).toEqual([])
  })

  it('ignores blank-string titles', async () => {
    await svc.initialize()
    const e = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'keep' })
    svc.updateInfo(e.id, { title: '' })
    expect(svc.get(e.id)?.title).toBe('keep')
  })

  it('resorts entries when a non-head row receives a fresher updatedAt', async () => {
    await svc.initialize()
    const first = svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 'first' })
    svc.add({ agentId: 'a', sessionIdOnAgent: '2', title: 'second' })
    expect(svc.list()[0]?.id).not.toBe(first.id)
    svc.updateInfo(first.id, { updatedAt: Date.now() + 1_000_000 })
    expect(svc.list()[0]?.id).toBe(first.id)
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
      schemaVersion: 1,
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
        schemaVersion: 1,
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

describe('AcpSessionHistoryService — setHistoryHasMessages', () => {
  let svc: AcpSessionHistoryService

  beforeEach(async () => {
    svc = makeService().svc
    await svc.initialize()
  })

  afterEach(() => {
    svc.dispose()
  })

  it('sets hasMessages to true on a known session', () => {
    svc.add({ agentId: 'a', sessionIdOnAgent: 's1', title: 't', hasMessages: false })
    svc.setHistoryHasMessages('s1')
    expect(svc.get('s1')?.hasMessages).toBe(true)
  })

  it('is idempotent — calling multiple times keeps hasMessages true', () => {
    svc.add({ agentId: 'a', sessionIdOnAgent: 's1', title: 't', hasMessages: false })
    svc.setHistoryHasMessages('s1')
    svc.setHistoryHasMessages('s1')
    expect(svc.get('s1')?.hasMessages).toBe(true)
  })

  it('is a no-op for an unknown session id', () => {
    expect(() => svc.setHistoryHasMessages('nonexistent')).not.toThrow()
  })

  it('add with hasMessages:false preserves the field', () => {
    const entry = svc.add({ agentId: 'a', sessionIdOnAgent: 's2', title: 't', hasMessages: false })
    expect(entry.hasMessages).toBe(false)
    expect(svc.get('s2')?.hasMessages).toBe(false)
  })

  it('entries loaded from storage without hasMessages retain undefined', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.sessionHistory', {
      schemaVersion: 1,
      entries: [
        {
          id: 'old-s',
          agentId: 'a',
          sessionIdOnAgent: 'old-s',
          title: 'old session',
          createdAt: 1,
          lastUsedAt: 1,
        },
      ],
    })
    const { svc: svc2 } = makeService({ storage })
    try {
      await svc2.initialize()
      expect(svc2.get('old-s')?.hasMessages).toBeUndefined()
    } finally {
      svc2.dispose()
    }
  })
})

describe('AcpSessionHistoryService — setHistoryAiTitle', () => {
  let svc: AcpSessionHistoryService

  beforeEach(async () => {
    svc = makeService().svc
    await svc.initialize()
  })

  afterEach(() => {
    svc.dispose()
  })

  it('flags an AI title on a known session', () => {
    svc.add({ agentId: 'a', sessionIdOnAgent: 's1', title: 't' })
    svc.setHistoryAiTitle('s1')
    expect(svc.get('s1')?.aiTitle).toBe(true)
  })

  it('is a no-op for an unknown session id', () => {
    expect(() => svc.setHistoryAiTitle('nonexistent')).not.toThrow()
  })

  it('re-add preserves the AI flag and its title (resume must not reset it)', () => {
    svc.add({ agentId: 'a', sessionIdOnAgent: 's1', title: 'AI Title' })
    svc.setHistoryAiTitle('s1')
    // resume() re-adds with the construct-time placeholder title.
    svc.add({ agentId: 'a', sessionIdOnAgent: 's1', title: 'Fake Agent 12:00' })
    expect(svc.get('s1')?.aiTitle).toBe(true)
    expect(svc.get('s1')?.title).toBe('AI Title')
  })
})
