/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpAgentDefaultsService.ts
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
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'

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
  svc: AcpAgentDefaultsService
  storage: FakeStorage
  workspace: FakeWorkspaceService
} {
  const storage = opts.storage ?? new FakeStorage()
  const workspace = opts.workspace ?? new FakeWorkspaceService()
  const svc = new AcpAgentDefaultsService(
    storage,
    workspace,
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
  return { svc, storage, workspace }
}

async function flushWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpAgentDefaultsService — get / set', () => {
  let svc: AcpAgentDefaultsService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('returns an empty object for unknown agentIds', async () => {
    await svc.initialize()
    expect(svc.getDefaults('nope')).toEqual({})
  })

  it('stores a fresh default and exposes it via getDefaults', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'claude-sonnet-4-6')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('merges defaults per agent, preserving siblings', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('claude-code', 'thought_level', 'high')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A', thought_level: 'high' })
  })

  it('keeps agents isolated from each other', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('codex', 'model', 'B')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A' })
    expect(svc.getDefaults('codex')).toEqual({ model: 'B' })
  })

  it('overwrites the same key without duplicating it', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    svc.setDefault('claude-code', 'model', 'B')
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'B' })
  })

  it('returns a clone — mutating the returned object does not affect state', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    const copy = svc.getDefaults('claude-code') as Record<string, string>
    copy['model'] = 'mutated'
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A' })
  })

  it('publishes via the defaults observable', async () => {
    await svc.initialize()
    expect(svc.defaults.get()).toEqual({})
    svc.setDefault('a', 'k', 'v')
    expect(svc.defaults.get()).toEqual({ a: { k: 'v' } })
  })
})

describe('AcpAgentDefaultsService — persistence', () => {
  let svc: AcpAgentDefaultsService
  let storage: FakeStorage
  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    storage = made.storage
  })
  afterEach(() => {
    svc.dispose()
  })

  it('writes after a debounce window with the right scope + schemaVersion', async () => {
    await svc.initialize()
    svc.setDefault('claude-code', 'model', 'A')
    expect(storage.setCalls.length).toBe(0)
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
    const call = storage.setCalls[0]!
    expect(call.key).toBe('acp.agentDefaults')
    expect(call.scope).toBe(StorageScope.WORKSPACE)
    const persisted = call.value as { schemaVersion: number; defaults: unknown }
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.defaults).toEqual({ 'claude-code': { model: 'A' } })
  })

  it('coalesces a burst of writes into a single set() call', async () => {
    await svc.initialize()
    svc.setDefault('a', 'k1', 'v1')
    svc.setDefault('a', 'k2', 'v2')
    svc.setDefault('b', 'k1', 'v3')
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
  })

  it('skips the write when the same value is set again', async () => {
    await svc.initialize()
    svc.setDefault('a', 'k', 'v')
    await flushWrite()
    const before = storage.setCalls.length
    svc.setDefault('a', 'k', 'v')
    await flushWrite()
    expect(storage.setCalls.length).toBe(before)
  })

  it('hydrates from storage on initialize()', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { 'claude-code': { model: 'A', thought_level: 'high' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('claude-code')).toEqual({ model: 'A', thought_level: 'high' })
  })

  it('ignores unknown schemaVersion (fails closed, empty map)', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
      schemaVersion: 999,
      defaults: { a: { k: 'v' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('a')).toEqual({})
  })

  it('rejects malformed defaults (non-string values)', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { a: { k: 123 } },
    })
    await svc.initialize()
    expect(svc.getDefaults('a')).toEqual({})
  })

  it('initialize() is idempotent — second call does not re-read', async () => {
    await svc.initialize()
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { late: { k: 'v' } },
    })
    await svc.initialize()
    expect(svc.getDefaults('late')).toEqual({})
  })
})

describe('AcpAgentDefaultsService — workspace scope', () => {
  it('with no workspace: falls back to GLOBAL once the scope event fires', async () => {
    const storage = new FakeStorage()
    const workspace = new FakeWorkspaceService(null)
    const { svc } = makeService({ storage, workspace })
    try {
      const initPromise = svc.initialize()
      storage.fireWorkspaceScopeChange()
      await initPromise
      svc.setDefault('a', 'k', 'v')
      await flushWrite()
      expect(storage.setCalls.at(-1)?.scope).toBe(StorageScope.GLOBAL)
    } finally {
      svc.dispose()
    }
  })

  it('workspace swap reloads defaults from the new bucket', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
      schemaVersion: 1,
      defaults: { 'claude-code': { model: 'A' } },
    })
    const workspace = new FakeWorkspaceService(makeFakeWorkspace('/work-a'))
    const { svc } = makeService({ storage, workspace })
    try {
      await svc.initialize()
      expect(svc.getDefaults('claude-code')).toEqual({ model: 'A' })

      // Simulate workspace B: clear bucket and seed different data, then fire event.
      storage.buckets.get(StorageScope.WORKSPACE)!.clear()
      storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.agentDefaults', {
        schemaVersion: 1,
        defaults: { 'claude-code': { model: 'B' } },
      })
      storage.fireWorkspaceScopeChange()
      await new Promise((r) => setTimeout(r, 20))
      expect(svc.getDefaults('claude-code')).toEqual({ model: 'B' })
    } finally {
      svc.dispose()
    }
  })
})
