/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionHistory.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  StorageScope,
  type ILogger,
  type ILoggerService,
  type IStorageService,
} from '@universe-editor/platform'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly setCalls: Array<{ key: string; value: unknown; scope?: StorageScope }> = []
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope?: StorageScope): Promise<void> {
    this.store.set(key, value)
    this.setCalls.push({ key, value, ...(scope !== undefined ? { scope } : {}) })
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
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

function makeService(storage: FakeStorage = new FakeStorage()): {
  svc: AcpSessionHistoryService
  storage: FakeStorage
} {
  const svc = new AcpSessionHistoryService(
    storage,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return { svc, storage }
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

  it('writes to storage GLOBAL scope after a debounce window', async () => {
    await svc.initialize()
    svc.add({ agentId: 'a', sessionIdOnAgent: '1', title: 't' })
    expect(storage.setCalls.length).toBe(0) // debounced
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
    const call = storage.setCalls[0]!
    expect(call.key).toBe('acp.sessionHistory')
    expect(call.scope).toBe(StorageScope.GLOBAL)
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
    storage.store.set('acp.sessionHistory', {
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
    storage.store.set('acp.sessionHistory', {
      schemaVersion: 999,
      entries: [
        { id: 'x', agentId: 'a', sessionIdOnAgent: 's', title: 't', createdAt: 1, lastUsedAt: 1 },
      ],
    })
    await svc.initialize()
    expect(svc.list()).toEqual([])
  })

  it('drops malformed entries during hydration but keeps the rest', async () => {
    storage.store.set('acp.sessionHistory', {
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
    storage.store.set('acp.sessionHistory', {
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
    storage.store.set('acp.sessionHistory', {
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
})
