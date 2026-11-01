/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/persistedStateBase.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  Event,
  NoopTelemetryService,
  StorageScope,
  URI,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import { StubLoggerService } from '../../../__tests__/_helpers/stubLoggerService.js'

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
  fireWorkspaceScope(): void {
    this._onDidChangeWorkspaceScope.fire()
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

class HookedState extends PersistedStateBase<{ entries: string[] }> {
  readonly events: string[] = []
  failNextLoad = false
  persistGate: (() => Promise<void>) | undefined
  persistFails = false

  constructor(storage: IStorageService, writeDebounceMs = 10_000) {
    super(
      storage,
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      {
        storageKey: 'hooked.state',
        loggerId: 'hooked',
        loggerName: 'Hooked',
        persistFailureEvent: 'hooked.persistFailure',
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
  protected override async _loadFromStorage(
    scope: StorageScope,
  ): Promise<{ entries: string[] } | undefined> {
    this.events.push(`load:${StorageScope[scope]}`)
    if (this.failNextLoad) {
      this.failNextLoad = false
      throw new Error('load failed')
    }
    return { entries: [`disk:${StorageScope[scope]}`] }
  }
  protected override async _persistToStorage(
    state: { entries: string[] },
    scope: StorageScope,
  ): Promise<void> {
    this.events.push(`persist:${StorageScope[scope]}:${state.entries.join(',')}`)
    if (this.persistFails) throw new Error('ipc down')
    await this.persistGate?.()
  }
  protected override async _onBeforeScopeChange(): Promise<void> {
    this.events.push('before-swap')
  }
  protected override _onAfterScopeChange(): void {
    this.events.push('after-swap')
  }
  protected _onStateReplaced(state: { entries: string[] }): void {
    this.events.push(`replace:${state.entries.join(',')}`)
  }
}

function makeHooked(): { svc: HookedState; storage: FakeStorage } {
  const storage = new FakeStorage()
  return { svc: new HookedState(storage), storage }
}

class MutableWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly recent = []
  readonly onDidChangeRecent = Event.None
  readonly onDidChangeWorkspace = Event.None
  readonly whenReady: Promise<void> = Promise.resolve()
  private _name = 'A'
  get current(): IWorkspace | null {
    return { folder: URI.file(`/${this._name}`), name: this._name }
  }
  set(name: string): void {
    this._name = name
  }
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async clearRecent(): Promise<void> {}
  async removeRecent(): Promise<void> {}
}

/** Loads a workspace-tagged payload and can park its read, like a slow shard read. */
class ReloadState extends PersistedStateBase<{ entries: string[] }> {
  readonly events: string[] = []
  workspaceTag = 'A'
  readonly loadGates = new Map<string, { entered: () => void; wait: Promise<void> }>()

  constructor(storage: IStorageService, workspace: IWorkspaceService) {
    super(storage, workspace, new NoopTelemetryService(), new StubLoggerService(), {
      storageKey: 'reload.state',
      loggerId: 'reload',
      loggerName: 'Reload',
      persistFailureEvent: 'reload.persistFailure',
      writeDebounceMs: 10_000,
    })
  }
  add(entry: string): void {
    this._state.entries.push(entry)
    this._scheduleWrite()
  }
  protected _emptyState(): { entries: string[] } {
    return { entries: [] }
  }
  protected _serialize(): unknown {
    return undefined
  }
  protected _deserialize(): { entries: string[] } | undefined {
    return undefined
  }
  protected override async _loadFromStorage(): Promise<{ entries: string[] } | undefined> {
    const tag = this.workspaceTag
    this.events.push(`load:${tag}`)
    const gate = this.loadGates.get(tag)
    if (gate) {
      gate.entered()
      await gate.wait
    }
    return { entries: [`disk:${tag}`] }
  }
  protected override async _persistToStorage(
    state: { entries: string[] },
    _scope: StorageScope,
  ): Promise<void> {
    this.events.push(`persist:${this.workspaceTag}:${state.entries.join(',')}`)
  }
  protected override _mergeOnLoad(
    loaded: { entries: string[] },
    current: { entries: string[] },
  ): { entries: string[] } {
    // Keep edits that arrived while the load was suspended — the point of the
    // dirty assertions below.
    const seen = new Set(loaded.entries)
    return { entries: [...loaded.entries, ...current.entries.filter((e) => !seen.has(e))] }
  }
  protected _onStateReplaced(state: { entries: string[] }): void {
    this.events.push(`replace:${state.entries.join(',')}`)
  }
}

function makeReload(): {
  svc: ReloadState
  storage: FakeStorage
  workspace: MutableWorkspaceService
} {
  const storage = new FakeStorage()
  const workspace = new MutableWorkspaceService()
  return { svc: new ReloadState(storage, workspace), storage, workspace }
}

describe('PersistedStateBase — persistence hooks and scope swap', () => {
  it('flush drains the debounce and persists immediately', async () => {
    const { svc } = makeHooked()
    await svc.initialize()
    svc.events.length = 0

    svc.add('a')
    await svc.flush()

    expect(svc.events).toEqual(['persist:WORKSPACE:disk:WORKSPACE,a'])
    svc.dispose()
  })

  it('dispose persists a trailing edit before the debounce fires', async () => {
    const { svc } = makeHooked()
    await svc.initialize()
    svc.events.length = 0

    svc.add('tail')
    svc.dispose()

    await expect
      .poll(() => svc.events.some((e) => e.startsWith('persist:') && e.endsWith(',tail')), {
        timeout: 1000,
      })
      .toBe(true)
  })

  it('flush drains an edit made while its own write is on the wire', async () => {
    const { svc } = makeHooked()
    await svc.initialize()
    svc.events.length = 0

    let entered!: () => void
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    svc.persistGate = async () => {
      entered()
      await gate
    }

    svc.add('a')
    const flushing = svc.flush()
    await enteredP
    // `_scheduleWrite` can only mark this dirty (a write is in flight); its
    // completion would otherwise arm a fresh long debounce and let flush resolve
    // before 'b' is persisted.
    svc.add('b')
    release()
    await flushing

    expect(svc.events.filter((e) => e.startsWith('persist:'))).toEqual([
      'persist:WORKSPACE:disk:WORKSPACE,a',
      'persist:WORKSPACE:disk:WORKSPACE,a,b',
    ])
    svc.dispose()
  })

  it('flush stops after a failed write instead of retrying forever', async () => {
    const { svc } = makeHooked()
    await svc.initialize()
    svc.events.length = 0
    svc.persistFails = true

    svc.add('a')
    await svc.flush()

    expect(svc.events.filter((e) => e.startsWith('persist:'))).toEqual([
      'persist:WORKSPACE:disk:WORKSPACE,a',
    ])
    svc.dispose()
  })

  it('waits for an in-flight write before the scope swap and loads afterwards', async () => {
    const { svc, storage } = makeHooked()
    await svc.initialize()
    svc.events.length = 0

    let entered!: () => void
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    svc.persistGate = async () => {
      entered()
      await gate
    }

    svc.add('old')
    const flushing = svc.flush()
    await enteredP
    storage.fireWorkspaceScope()
    await new Promise((r) => setTimeout(r, 10))
    // The swap must not run its before-hook while the old write is on the wire.
    expect(svc.events).not.toContain('before-swap')

    release()
    await flushing
    await expect
      .poll(
        () =>
          svc.events.includes('load:WORKSPACE') &&
          svc.events.includes('before-swap') &&
          svc.events.includes('after-swap'),
        {
          timeout: 1000,
        },
      )
      .toBe(true)

    const beforeAt = svc.events.indexOf('before-swap')
    const persistAt = svc.events.findIndex((e) => e.startsWith('persist:'))
    expect(beforeAt).toBeGreaterThan(persistAt)
    expect(svc.events.indexOf('replace:disk:WORKSPACE')).toBeGreaterThan(beforeAt)
    expect(svc.events.indexOf('after-swap')).toBeGreaterThan(
      svc.events.indexOf('replace:disk:WORKSPACE'),
    )
    svc.dispose()
  })

  it('keeps the current state when the load throws instead of treating it as empty', async () => {
    const { svc } = makeHooked()
    svc.failNextLoad = true

    await svc.initialize()
    expect(svc.events).toContain('load:WORKSPACE')
    expect(svc.events).not.toContain('replace:')

    svc.events.length = 0
    svc.add('after-failure')
    await svc.flush()
    expect(svc.events).toEqual(['persist:WORKSPACE:after-failure'])
    svc.dispose()
  })
})

describe('PersistedStateBase — serialized reloads', () => {
  it('does not let a slow, superseded load publish into the newer scope', async () => {
    const { svc, storage, workspace } = makeReload()
    await svc.initialize()
    svc.events.length = 0

    let entered!: () => void
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    svc.loadGates.set('B', { entered, wait: gate })

    // A -> B: B's shard read parks.
    svc.workspaceTag = 'B'
    workspace.set('B')
    storage.fireWorkspaceScope()
    await enteredP
    // An edit lands while the swap is suspended (no debounce is armed for it).
    svc.add('dirty')

    // B -> C before B's read resolves.
    svc.workspaceTag = 'C'
    workspace.set('C')
    storage.fireWorkspaceScope()
    release()

    await expect
      .poll(() => svc.events.some((e) => e === 'replace:disk:C,dirty'), { timeout: 1000 })
      .toBe(true)
    await svc.flush()

    // The stale B read must never be published or persisted.
    expect(svc.events).not.toContain('replace:disk:B')
    expect(svc.events.filter((e) => e.startsWith('load:'))).toEqual(['load:B', 'load:C'])
    // The edit made mid-swap survives and lands only in the final scope.
    expect(svc.events.filter((e) => e.startsWith('persist:'))).toEqual(['persist:C:disk:C,dirty'])
    svc.dispose()
  })

  it('does not let the initial load publish after a scope swap superseded it', async () => {
    const { svc, storage, workspace } = makeReload()

    let entered!: () => void
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    svc.loadGates.set('A', { entered, wait: gate })

    const initializing = svc.initialize()
    await enteredP
    svc.workspaceTag = 'B'
    workspace.set('B')
    storage.fireWorkspaceScope()
    release()
    await initializing

    await expect.poll(() => svc.events.includes('replace:disk:B'), { timeout: 1000 }).toBe(true)
    expect(svc.events).not.toContain('replace:disk:A')
    svc.dispose()
  })
})
