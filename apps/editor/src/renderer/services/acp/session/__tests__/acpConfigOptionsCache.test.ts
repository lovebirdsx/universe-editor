/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpConfigOptionsCache.ts
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
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { AcpConfigOptionsCacheService } from '../acpConfigOptionsCache.js'

function modelOption(currentValue: string): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  }
}

const MODEL_BAG: readonly SessionConfigOption[] = [modelOption('sonnet')]

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
}

function makeService(opts: MakeOptions = {}): {
  svc: AcpConfigOptionsCacheService
  storage: FakeStorage
  workspace: FakeWorkspaceService
} {
  const storage = opts.storage ?? new FakeStorage()
  const workspace = opts.workspace ?? new FakeWorkspaceService()
  const svc = new AcpConfigOptionsCacheService(
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

describe('AcpConfigOptionsCacheService — get / set', () => {
  let svc: AcpConfigOptionsCacheService
  beforeEach(() => {
    svc = makeService().svc
  })
  afterEach(() => {
    svc.dispose()
  })

  it('returns an empty array for unknown agentIds', async () => {
    await svc.initialize()
    expect(svc.get('nope')).toEqual([])
  })

  it('stores a bag and exposes it via get', async () => {
    await svc.initialize()
    svc.set('claude-code', MODEL_BAG)
    expect(svc.get('claude-code')).toEqual(MODEL_BAG)
  })

  it('keeps agents isolated from each other', async () => {
    await svc.initialize()
    svc.set('claude-code', MODEL_BAG)
    expect(svc.get('codex')).toEqual([])
  })

  it('replaces the bag for the same agent', async () => {
    await svc.initialize()
    svc.set('claude-code', MODEL_BAG)
    const next: readonly SessionConfigOption[] = [modelOption('opus')]
    svc.set('claude-code', next)
    expect(svc.get('claude-code')[0]?.currentValue).toBe('opus')
  })

  it('publishes via the cache observable', async () => {
    await svc.initialize()
    expect(svc.cache.get()).toEqual({})
    svc.set('a', MODEL_BAG)
    expect(svc.cache.get()).toEqual({ a: MODEL_BAG })
  })
})

describe('AcpConfigOptionsCacheService — persistence', () => {
  let svc: AcpConfigOptionsCacheService
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
    svc.set('claude-code', MODEL_BAG)
    expect(storage.setCalls.length).toBe(0)
    await flushWrite()
    expect(storage.setCalls.length).toBe(1)
    const call = storage.setCalls[0]!
    expect(call.key).toBe('acp.configOptionsCache')
    expect(call.scope).toBe(StorageScope.WORKSPACE)
    const persisted = call.value as { schemaVersion: number; cache: unknown }
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.cache).toEqual({ 'claude-code': MODEL_BAG })
  })

  it('hydrates from storage on initialize()', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.configOptionsCache', {
      schemaVersion: 1,
      cache: { 'claude-code': MODEL_BAG },
    })
    await svc.initialize()
    expect(svc.get('claude-code')).toEqual(MODEL_BAG)
  })

  it('ignores unknown schemaVersion (fails closed, empty map)', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.configOptionsCache', {
      schemaVersion: 999,
      cache: { a: MODEL_BAG },
    })
    await svc.initialize()
    expect(svc.get('a')).toEqual([])
  })

  it('rejects malformed bags (entry without string id)', async () => {
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.configOptionsCache', {
      schemaVersion: 1,
      cache: { a: [{ name: 'no id' }] },
    })
    await svc.initialize()
    expect(svc.get('a')).toEqual([])
  })
})

describe('AcpConfigOptionsCacheService — workspace scope', () => {
  it('workspace swap reloads the cache from the new bucket', async () => {
    const storage = new FakeStorage()
    storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.configOptionsCache', {
      schemaVersion: 1,
      cache: { 'claude-code': MODEL_BAG },
    })
    const workspace = new FakeWorkspaceService(makeFakeWorkspace('/work-a'))
    const { svc } = makeService({ storage, workspace })
    try {
      await svc.initialize()
      expect(svc.get('claude-code')).toEqual(MODEL_BAG)

      const next: readonly SessionConfigOption[] = [modelOption('opus')]
      storage.buckets.get(StorageScope.WORKSPACE)!.clear()
      storage.buckets.get(StorageScope.WORKSPACE)!.set('acp.configOptionsCache', {
        schemaVersion: 1,
        cache: { 'claude-code': next },
      })
      storage.fireWorkspaceScopeChange()
      await new Promise((r) => setTimeout(r, 20))
      expect(svc.get('claude-code')[0]?.currentValue).toBe('opus')
    } finally {
      svc.dispose()
    }
  })
})
