/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/persistedStateBase.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
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
import { PersistedStateBase } from '../persistedStateBase.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly buckets = new Map<StorageScope, Map<string, unknown>>([
    [StorageScope.GLOBAL, new Map()],
    [StorageScope.WORKSPACE, new Map()],
  ])
  setCallCount = 0
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  async get<T = unknown>(
    key: string,
    scope: StorageScope = StorageScope.GLOBAL,
  ): Promise<T | undefined> {
    return this.buckets.get(scope)?.get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.setCallCount++
    this.buckets.get(scope)!.set(key, value)
  }
  async remove(key: string, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    this.buckets.get(scope)!.delete(key)
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady: Promise<void> = Promise.resolve()
  get current(): IWorkspace | null {
    return { folder: URI.file('/work'), name: '/work' }
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

class TestState extends PersistedStateBase<{ entries: string[] }> {
  constructor(storage: IStorageService, writeDebounceMs = 20) {
    super(
      storage,
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      {
        storageKey: 'test.state',
        loggerId: 'test',
        loggerName: 'Test',
        persistFailureEvent: 'test.persistFailure',
        writeDebounceMs,
      },
    )
  }
  add(entry: string): void {
    this._state.entries.push(entry)
    this._scheduleWrite()
  }
  protected _emptyState(): { entries: string[] } {
    return { entries: [] }
  }
  protected _serialize(state: { entries: string[] }): unknown {
    return { entries: [...state.entries] }
  }
  protected _deserialize(raw: unknown): { entries: string[] } | undefined {
    if (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)) {
      return { entries: (raw as { entries: string[] }).entries }
    }
    return undefined
  }
  protected _onStateReplaced(): void {}
}

function makeService(writeDebounceMs = 20): { svc: TestState; storage: FakeStorage } {
  const storage = new FakeStorage()
  return { svc: new TestState(storage, writeDebounceMs), storage }
}

describe('PersistedStateBase — write backpressure', () => {
  it('serializes back-to-back changes into a single debounced write', async () => {
    const { svc, storage } = makeService()
    await svc.initialize()
    svc.add('a')
    svc.add('b')
    svc.add('c')
    await new Promise((r) => setTimeout(r, 100))
    expect(storage.setCallCount).toBe(1)
    const persisted = storage.buckets.get(StorageScope.WORKSPACE)!.get('test.state') as {
      entries: string[]
    }
    expect(persisted.entries).toEqual(['a', 'b', 'c'])
    svc.dispose()
  })

  it('does not stack new writes while one is in flight; dirty changes trigger one follow-up', async () => {
    const { svc, storage } = makeService()
    await svc.initialize()

    // Hold the first write in flight by gating storage.set.
    let releaseFirst!: () => void
    const firstWriteGate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const originalSet = storage.set.bind(storage)
    let gatedCalls = 0
    storage.set = async (key, value, scope) => {
      if (gatedCalls === 0) {
        gatedCalls++
        await firstWriteGate
      }
      return originalSet(key, value, scope)
    }

    svc.add('first')
    // Wait past the debounce so the first write is in flight (blocked on gate).
    await new Promise((r) => setTimeout(r, 60))
    expect(gatedCalls).toBe(1)

    // More changes arrive while the write is in flight — must NOT each fire
    // their own write; they mark dirty and coalesce into ONE follow-up.
    svc.add('second')
    svc.add('third')
    await new Promise((r) => setTimeout(r, 60))
    expect(gatedCalls).toBe(1)

    releaseFirst()
    await new Promise((r) => setTimeout(r, 100))

    // In-flight 1 + follow-up 1 — not 1 + N.
    expect(storage.setCallCount).toBe(2)
    const persisted = storage.buckets.get(StorageScope.WORKSPACE)!.get('test.state') as {
      entries: string[]
    }
    expect(persisted.entries).toEqual(['first', 'second', 'third'])
    svc.dispose()
  })

  it('a failed write does not swallow pending dirty state; next schedule retries', async () => {
    const { svc, storage } = makeService()
    await svc.initialize()

    const originalSet = storage.set.bind(storage)
    let failOnce = true
    storage.set = async (key, value, scope) => {
      if (failOnce) {
        failOnce = false
        throw new Error('ipc down')
      }
      return originalSet(key, value, scope)
    }

    svc.add('a')
    await new Promise((r) => setTimeout(r, 60))
    // Failed write logged via telemetry, state still pending — a later change
    // must persist everything.
    svc.add('b')
    await new Promise((r) => setTimeout(r, 100))
    const persisted = storage.buckets.get(StorageScope.WORKSPACE)!.get('test.state') as
      | { entries: string[] }
      | undefined
    expect(persisted?.entries).toEqual(['a', 'b'])
    svc.dispose()
  })
})
