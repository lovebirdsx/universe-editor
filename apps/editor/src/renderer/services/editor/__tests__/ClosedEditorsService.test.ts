/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ClosedEditorsService and the ReopenClosedEditorAction that consumes it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  EditorInput,
  EditorRegistry,
  Emitter,
  IContextKeyService,
  IEditorGroupsService,
  IFocusStackService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  registerAction2,
  type Event,
  type IFocusEntry,
  type IStorageService as IStorageServiceType,
  type PartId,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import {
  ClosedEditorsService,
  IClosedEditorsService,
  MAX_PERSISTED_ENTRY_BYTES,
} from '../ClosedEditorsService.js'
import { ReopenClosedEditorAction } from '../../../actions/editorActions.js'

// ---------------------------------------------------------------------------
// Fake input types used by tests
// ---------------------------------------------------------------------------

class FakeVirtualInput extends EditorInput {
  static readonly TYPE_ID = 'fake.virtual.closed.test'
  private static _counter = 0

  private readonly _uri: string
  constructor(label = 'fake') {
    super()
    this._uri = `virtual:///${label}-${FakeVirtualInput._counter++}`
  }
  override get typeId() {
    return FakeVirtualInput.TYPE_ID
  }
  override get resource() {
    return URI.parse(this._uri)
  }
  override getName() {
    return 'FakeVirtual'
  }
  override serialize(): { uri: string } {
    return { uri: this._uri }
  }
  static deserialize(data: unknown): FakeVirtualInput {
    const inst = new FakeVirtualInput()
    // Restore URI from serialized data
    ;(inst as unknown as { _uri: string })._uri = (data as { uri: string }).uri
    return inst
  }
}

class FakeNoSerializeInput extends EditorInput {
  static readonly TYPE_ID = 'fake.noserialize.closed.test'
  constructor(private readonly _id: string) {
    super()
  }
  override get typeId() {
    return FakeNoSerializeInput.TYPE_ID
  }
  override get resource() {
    return URI.parse(`virtual:///noserialize-${this._id}`)
  }
  override getName() {
    return 'FakeNoSerialize'
  }
  // No serialize() — simulates WelcomeEditorInput, GitGraphEditorInput, etc.
  static deserialize(): FakeNoSerializeInput {
    return new FakeNoSerializeInput('restored')
  }
}

// Two inputs that deliberately share one `resource` but differ in `typeId`,
// mirroring an image preview and the text view of the same file.
class FakeTextInput extends EditorInput {
  static readonly TYPE_ID = 'fake.shared.text.closed.test'
  constructor(private readonly _resource: URI) {
    super()
  }
  override get typeId() {
    return FakeTextInput.TYPE_ID
  }
  override get resource() {
    return this._resource
  }
  override getName() {
    return 'FakeText'
  }
}

class FakeImageInput extends EditorInput {
  static readonly TYPE_ID = 'fake.shared.image.closed.test'
  constructor(
    private readonly _resource: URI,
    private readonly _tag = '',
  ) {
    super()
  }
  override get typeId() {
    return FakeImageInput.TYPE_ID
  }
  override get resource() {
    return this._resource
  }
  override get id() {
    return `fake-image:${this._resource.toString()}`
  }
  override getName() {
    return 'FakeImage'
  }
  override serialize(): { uri: string; tag: string } {
    return { uri: this._resource.toString(), tag: this._tag }
  }
  static deserialize(data: unknown): FakeImageInput {
    const d = data as { uri: string; tag?: string }
    return new FakeImageInput(URI.parse(d.uri), d.tag ?? '')
  }
}

/** Input whose serialized payload is arbitrarily large — mirrors DiffEditorInput
 *  persisting both sides' full text. */
class FakeBigInput extends EditorInput {
  static readonly TYPE_ID = 'fake.big.closed.test'
  constructor(private readonly _payload: string) {
    super()
  }
  override get typeId() {
    return FakeBigInput.TYPE_ID
  }
  override get resource() {
    return URI.parse('virtual:///big')
  }
  override getName() {
    return 'FakeBig'
  }
  override serialize(): { payload: string } {
    return { payload: this._payload }
  }
}

// ---------------------------------------------------------------------------
// Fake IFocusStackService
// ---------------------------------------------------------------------------

class FakeFocusStackService implements IFocusStackService {
  declare readonly _serviceBrand: undefined
  readonly onDidChange: Event<void> = new Emitter<void>().event
  push(_entry: Omit<IFocusEntry, 'timestamp'>): void {}
  getTop(): IFocusEntry | undefined {
    return undefined
  }
  getAll(): readonly IFocusEntry[] {
    return []
  }
  nextPart(): PartId | undefined {
    return undefined
  }
  previousPart(): PartId | undefined {
    return undefined
  }
  clear(): void {}
}

// ---------------------------------------------------------------------------
// Fake IStorageService — JSON round-trips values like the real disk-backed
// backend, so a missing URI.revive in the service under test fails loudly.
// ---------------------------------------------------------------------------

class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private _data = new Map<string, unknown>()
  private readonly _scopeEmitter = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._scopeEmitter.event

  async get<T>(key: string): Promise<T | undefined> {
    return this._data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this._data.set(key, JSON.parse(JSON.stringify(value)))
  }
  async remove(key: string): Promise<void> {
    this._data.delete(key)
  }
  swapWorkspaceScope(): void {
    this._data = new Map()
    this._scopeEmitter.fire()
  }
}

function makeSvc(
  groups: EditorGroupsService,
  storage: IStorageServiceType = new FakeStorage(),
  persistDebounceMs = 0,
) {
  const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'), storage, null!)
  svc._setPersistDebounceMsForTests(persistDebounceMs)
  return svc
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cleanupRegistry: Array<() => void> = []

beforeEach(() => {
  const d1 = EditorRegistry.registerEditorProvider({
    typeId: FakeVirtualInput.TYPE_ID,
    componentKey: 'fake.virtual',
    deserialize: (data) => FakeVirtualInput.deserialize(data),
  })
  const d2 = EditorRegistry.registerEditorProvider({
    typeId: FakeNoSerializeInput.TYPE_ID,
    componentKey: 'fake.noserialize',
    deserialize: () => FakeNoSerializeInput.deserialize(),
  })
  cleanupRegistry.push(
    () => d1.dispose(),
    () => d2.dispose(),
  )
})

afterEach(() => {
  for (const cleanup of cleanupRegistry) cleanup()
  cleanupRegistry = []
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — stack behavior
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — stack behavior', () => {
  it('popMostRecent returns undefined when no editor has been closed', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    expect(svc.popMostRecent()).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })

  it('returns the most recently closed editor entry', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const a = new FakeVirtualInput('a')
    const b = new FakeVirtualInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.closeEditor(b)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    svc.dispose()
    groups.dispose()
  })

  it('captures typeId correctly for non-text (virtual) editors', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const input = new FakeNoSerializeInput('x')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeNoSerializeInput.TYPE_ID)
    svc.dispose()
    groups.dispose()
  })

  it('captures serializedData from editor.serialize() when implemented', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const input = new FakeVirtualInput('ser')
    groups.activeGroup.openEditor(input)
    const expectedData = input.serialize()
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.serializedData).toEqual(expectedData)
    svc.dispose()
    groups.dispose()
  })

  it('serializedData is null for editors without serialize()', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const input = new FakeNoSerializeInput('noser')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.serializedData).toBeNull()
    svc.dispose()
    groups.dispose()
  })

  it('popMostRecent skips entries whose editor is already open', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const a = new FakeVirtualInput('skip-a')
    const b = new FakeVirtualInput('skip-b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    // Close b, then reopen it — b is now open again
    groups.activeGroup.closeEditor(b)
    groups.activeGroup.openEditor(b)
    // Also close a
    groups.activeGroup.closeEditor(a)

    // b is in the stack but already open, so popMostRecent should skip it and return a
    const entry = svc.popMostRecent()
    expect(entry!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    expect(entry!.resource.toString()).toBe(a.resource.toString())
    svc.dispose()
    groups.dispose()
  })

  it('does not skip a closed editor when a different-typed editor of the same file stays open', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/pics/logo.svg')
    const text = new FakeTextInput(uri)
    const image = new FakeImageInput(uri)
    groups.activeGroup.openEditor(text)
    groups.activeGroup.openEditor(image)
    // Close the image tab; the text tab of the same file is still open.
    groups.activeGroup.closeEditor(image)

    // Resource matches the open text tab, but typeId differs — must still reopen.
    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeImageInput.TYPE_ID)
    expect(entry!.resource.toString()).toBe(uri.toString())
    svc.dispose()
    groups.dispose()
  })

  it('records a preview editor evicted in-place (single-click replace), not just closes', () => {
    // Single-click in the SCM list opens into the single preview slot; clicking a
    // second file replaces the first in-place (previewReplace, no 'close' event).
    // The evicted preview must still be reopenable via Ctrl+Shift+T.
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const a = new FakeVirtualInput('preview-a')
    const b = new FakeVirtualInput('preview-b')
    groups.activeGroup.openEditor(a, { pinned: false })
    groups.activeGroup.openEditor(b, { pinned: false }) // evicts a in-place

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.resource.toString()).toBe(a.resource.toString())
    expect(entry!.serializedData).toEqual(a.serialize())
    svc.dispose()
    groups.dispose()
  })

  it('stack is LIFO — most recently closed comes first', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const a = new FakeVirtualInput('lifo-a')
    const b = new FakeVirtualInput('lifo-b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.closeEditor(a)
    groups.activeGroup.closeEditor(b)

    // b was closed last, so it should come first
    const first = svc.popMostRecent()
    expect(first!.resource.toString()).toBe(b.resource.toString())
    const second = svc.popMostRecent()
    expect(second!.resource.toString()).toBe(a.resource.toString())
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — takeMostRecentMatching (quick-open restore)
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — takeMostRecentMatching', () => {
  it('returns undefined when nothing was closed', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    expect(svc.takeMostRecentMatching(URI.file('/w/a.png'))).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })

  it('returns the newest entry matching the resource and removes only it', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/pic.png')
    const other = new FakeVirtualInput('other')
    const first = new FakeImageInput(uri)
    const second = new FakeImageInput(uri)
    groups.activeGroup.openEditor(other)
    groups.activeGroup.openEditor(first)
    groups.activeGroup.closeEditor(first)
    groups.activeGroup.openEditor(second)
    groups.activeGroup.closeEditor(second)
    groups.activeGroup.closeEditor(other)

    const entry = svc.takeMostRecentMatching(uri)
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeImageInput.TYPE_ID)
    expect(entry!.serializedData).toEqual(second.serialize())

    // The same-resource earlier entry was replaced by the newer close (dedup);
    // only the other-resource entry stays in the stack.
    const next = svc.popMostRecent()
    expect(next!.resource.toString()).toBe(other.resource.toString())
    expect(svc.popMostRecent()).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })

  it('skips a matching entry whose (typeId, resource) is currently open', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/pic.png')
    const image = new FakeImageInput(uri)
    groups.activeGroup.openEditor(image)
    groups.activeGroup.closeEditor(image)
    // Reopen the same image tab — the stack entry is now stale.
    groups.activeGroup.openEditor(image)

    expect(svc.takeMostRecentMatching(uri)).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })

  it('does not skip when only a different-typed editor of the same file is open', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/pic.png')
    const text = new FakeTextInput(uri)
    const image = new FakeImageInput(uri)
    groups.activeGroup.openEditor(image)
    groups.activeGroup.closeEditor(image)
    groups.activeGroup.openEditor(text)

    const entry = svc.takeMostRecentMatching(uri)
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeImageInput.TYPE_ID)
    svc.dispose()
    groups.dispose()
  })

  it('returns undefined when no entry matches the resource', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const input = new FakeVirtualInput('unrelated')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)

    expect(svc.takeMostRecentMatching(URI.file('/w/never-closed.png'))).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — getClosedEditors (quick-open listing)
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — getClosedEditors', () => {
  it('returns entries newest-first and captures the editor label', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const a = new FakeVirtualInput('list-a')
    const b = new FakeVirtualInput('list-b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.closeEditor(a)
    groups.activeGroup.closeEditor(b)

    const entries = svc.getClosedEditors()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.resource.toString()).toBe(b.resource.toString())
    expect(entries[0]!.label).toBe('FakeVirtual')
    expect(entries[1]!.resource.toString()).toBe(a.resource.toString())
    svc.dispose()
    groups.dispose()
  })

  it('skips entries whose (typeId, resource) is currently open', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/pic.png')
    const text = new FakeTextInput(uri)
    const image = new FakeImageInput(uri)
    groups.activeGroup.openEditor(image)
    groups.activeGroup.closeEditor(image)
    // The text view of the same file stays open — different typeId, so the
    // closed image entry must still be listed.
    groups.activeGroup.openEditor(text)

    expect(svc.getClosedEditors()).toHaveLength(1)

    // Reopen the image tab — now the entry is stale and must disappear.
    groups.activeGroup.openEditor(image)
    expect(svc.getClosedEditors()).toHaveLength(0)
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — persistence across restarts
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — persistence across restarts', () => {
  it('restores the closed stack from storage in a fresh service (editor restart)', async () => {
    const storage = new FakeStorage()
    const groups1 = new EditorGroupsService()
    const svc1 = makeSvc(groups1, storage)
    const input = new FakeVirtualInput('persist')
    groups1.activeGroup.openEditor(input)
    groups1.activeGroup.closeEditor(input)
    await flush()
    svc1.dispose()
    groups1.dispose()

    // Fresh groups + service over the same storage — simulates an app restart.
    const groups2 = new EditorGroupsService()
    const svc2 = makeSvc(groups2, storage)
    await flush()

    const entries = svc2.getClosedEditors()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    expect(entries[0]!.label).toBe('FakeVirtual')
    expect(entries[0]!.serializedData).toEqual(input.serialize())
    // resource must be a revived URI, not a plain persisted object.
    expect(entries[0]!.resource.toString()).toBe(input.resource.toString())
    svc2.dispose()
    groups2.dispose()
  })

  it('takeMostRecentMatching after a restart returns a deserializable entry and consumes it durably', async () => {
    const storage = new FakeStorage()
    const groups1 = new EditorGroupsService()
    const svc1 = makeSvc(groups1, storage)
    const input = new FakeVirtualInput('take-restart')
    groups1.activeGroup.openEditor(input)
    groups1.activeGroup.closeEditor(input)
    await flush()
    svc1.dispose()
    groups1.dispose()

    const groups2 = new EditorGroupsService()
    const svc2 = makeSvc(groups2, storage)
    await flush()
    const entry = svc2.takeMostRecentMatching(input.resource)
    expect(entry).toBeDefined()
    const restored = EditorRegistry.deserialize(entry!.typeId, entry!.serializedData)
    expect(restored).toBeInstanceOf(FakeVirtualInput)
    expect(restored!.resource!.toString()).toBe(input.resource.toString())
    await flush()
    svc2.dispose()
    groups2.dispose()

    // Third boot: the consumed entry must not resurface.
    const groups3 = new EditorGroupsService()
    const svc3 = makeSvc(groups3, storage)
    await flush()
    expect(svc3.getClosedEditors()).toHaveLength(0)
    svc3.dispose()
    groups3.dispose()
  })

  it('popMostRecent consumption is persisted', async () => {
    const storage = new FakeStorage()
    const groups1 = new EditorGroupsService()
    const svc1 = makeSvc(groups1, storage)
    const input = new FakeVirtualInput('pop-restart')
    groups1.activeGroup.openEditor(input)
    groups1.activeGroup.closeEditor(input)
    await flush()
    expect(svc1.popMostRecent()).toBeDefined()
    await flush()
    svc1.dispose()
    groups1.dispose()

    const groups2 = new EditorGroupsService()
    const svc2 = makeSvc(groups2, storage)
    await flush()
    expect(svc2.getClosedEditors()).toHaveLength(0)
    svc2.dispose()
    groups2.dispose()
  })

  it('keeps entries closed before the persisted stack finishes loading (merge, newest on top)', async () => {
    const storage = new FakeStorage()
    const groups1 = new EditorGroupsService()
    const svc1 = makeSvc(groups1, storage)
    const old = new FakeVirtualInput('old-session')
    groups1.activeGroup.openEditor(old)
    groups1.activeGroup.closeEditor(old)
    await flush()
    svc1.dispose()
    groups1.dispose()

    const groups2 = new EditorGroupsService()
    const svc2 = makeSvc(groups2, storage)
    // Close a new editor immediately — before the async load resolves.
    const fresh = new FakeVirtualInput('fresh')
    groups2.activeGroup.openEditor(fresh)
    groups2.activeGroup.closeEditor(fresh)
    await flush()

    const entries = svc2.getClosedEditors()
    expect(entries.map((e) => e.resource.toString())).toEqual([
      fresh.resource.toString(),
      old.resource.toString(),
    ])
    svc2.dispose()
    groups2.dispose()
  })

  it('resets the stack when the workspace scope changes', async () => {
    const storage = new FakeStorage()
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups, storage)
    const input = new FakeVirtualInput('scoped')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)
    await flush()
    expect(svc.getClosedEditors()).toHaveLength(1)

    storage.swapWorkspaceScope()
    await flush()
    expect(svc.getClosedEditors()).toHaveLength(0)
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — dedup, size budget, debounce, error containment
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — close-path cost guards', () => {
  it('closing the same (typeId, resource) twice keeps only the newest entry', () => {
    const groups = new EditorGroupsService()
    const svc = makeSvc(groups)
    const uri = URI.file('/w/dup.png')
    const first = new FakeImageInput(uri, 'first')
    const second = new FakeImageInput(uri, 'second')
    groups.activeGroup.openEditor(first)
    groups.activeGroup.closeEditor(first)
    groups.activeGroup.openEditor(second)
    groups.activeGroup.closeEditor(second)

    const entries = svc.getClosedEditors()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.serializedData).toEqual(second.serialize())
    svc.dispose()
    groups.dispose()
  })

  it('oversized entries stay reopenable in-session but are never persisted across restarts', async () => {
    const storage = new FakeStorage()
    const groups1 = new EditorGroupsService()
    const svc1 = makeSvc(groups1, storage)
    const small = new FakeVirtualInput('small')
    const big = new FakeBigInput('x'.repeat(MAX_PERSISTED_ENTRY_BYTES + 1))
    groups1.activeGroup.openEditor(small)
    groups1.activeGroup.closeEditor(small)
    groups1.activeGroup.openEditor(big)
    groups1.activeGroup.closeEditor(big)

    // Same session: the oversized entry keeps its full payload in memory.
    const entries = svc1.getClosedEditors()
    expect(entries).toHaveLength(2)
    const bigEntry = entries.find((e) => e.typeId === FakeBigInput.TYPE_ID)!
    expect((bigEntry.serializedData as { payload: string }).payload).toHaveLength(
      MAX_PERSISTED_ENTRY_BYTES + 1,
    )
    await flush()
    svc1.dispose()
    groups1.dispose()

    // After a restart only the small entry comes back.
    const groups2 = new EditorGroupsService()
    const svc2 = makeSvc(groups2, storage)
    await flush()
    const restored = svc2.getClosedEditors()
    expect(restored).toHaveLength(1)
    expect(restored[0]!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    svc2.dispose()
    groups2.dispose()
  })

  it('coalesces a burst of closes into a single storage write', async () => {
    vi.useFakeTimers()
    try {
      class CountingStorage extends FakeStorage {
        setCount = 0
        override async set(key: string, value: unknown): Promise<void> {
          this.setCount++
          await super.set(key, value)
        }
      }
      const storage = new CountingStorage()
      const groups = new EditorGroupsService()
      const svc = makeSvc(groups, storage, 100)
      for (const label of ['burst-a', 'burst-b', 'burst-c']) {
        const input = new FakeVirtualInput(label)
        groups.activeGroup.openEditor(input)
        groups.activeGroup.closeEditor(input)
      }
      expect(storage.setCount).toBe(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(storage.setCount).toBe(1)
      svc.dispose()
      groups.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failing storage.set is contained, not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      class RejectingStorage extends FakeStorage {
        override async set(): Promise<void> {
          throw new Error('value too large')
        }
      }
      const groups = new EditorGroupsService()
      const svc = makeSvc(groups, new RejectingStorage())
      const input = new FakeVirtualInput('reject')
      groups.activeGroup.openEditor(input)
      groups.activeGroup.closeEditor(input)
      await flush()
      await flush()
      expect(unhandled).toHaveLength(0)
      svc.dispose()
      groups.dispose()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ---------------------------------------------------------------------------
// ReopenClosedEditorAction — uses EditorRegistry.deserialize, not FileEditorInput
// ---------------------------------------------------------------------------

describe('ReopenClosedEditorAction', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(ReopenClosedEditorAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function makeHarness() {
    const groups = new EditorGroupsService()
    const closedSvc = makeSvc(groups)
    const focusSvc = new FakeFocusStackService()

    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups)
    services.set(IClosedEditorsService, closedSvc)
    services.set(IFocusStackService, focusSvc)
    services.set(IContextKeyService, new ContextKeyService())
    const inst = new InstantiationService(services)

    return { groups, closedSvc, inst }
  }

  function runAction(harness: ReturnType<typeof makeHarness>): void {
    const cmd = CommandsRegistry.getCommand(ReopenClosedEditorAction.ID)
    if (!cmd) throw new Error('ReopenClosedEditorAction not registered')
    harness.inst.invokeFunction((accessor) => cmd.handler(accessor))
  }

  it('does nothing when the closed-editors stack is empty', () => {
    const h = makeHarness()
    // Should not throw
    runAction(h)
    expect(h.groups.activeGroup.editors).toHaveLength(0)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('reopens a non-text editor with the correct typeId (bug: was FileEditorInput)', () => {
    const h = makeHarness()
    const input = new FakeVirtualInput('reopen')
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)
    // Stack now has the entry with typeId=FakeVirtualInput.TYPE_ID

    runAction(h)

    const reopened = h.groups.activeGroup.activeEditor
    expect(reopened).toBeDefined()
    expect(reopened!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('reopens a non-serialize editor with the correct typeId', () => {
    const h = makeHarness()
    const input = new FakeNoSerializeInput('noser-reopen')
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)

    runAction(h)

    const reopened = h.groups.activeGroup.activeEditor
    expect(reopened).toBeDefined()
    expect(reopened!.typeId).toBe(FakeNoSerializeInput.TYPE_ID)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('skips an entry when EditorRegistry has no deserialize for that typeId', () => {
    // Simulate a TerminalEditorInput (no deserialize registered)
    class NoDeserializeInput extends EditorInput {
      static readonly TYPE_ID = 'fake.nodeserialize'
      override get typeId() {
        return NoDeserializeInput.TYPE_ID
      }
      override get resource() {
        return URI.parse('virtual:///nodeserialize')
      }
      override getName() {
        return 'NoDeserialize'
      }
    }

    // Register without a deserialize hook
    const d = EditorRegistry.registerEditorProvider({
      typeId: NoDeserializeInput.TYPE_ID,
      componentKey: 'fake.nodeserialize',
      // No deserialize
    })

    const h = makeHarness()
    const input = new NoDeserializeInput()
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)

    runAction(h)

    // Nothing should be reopened — entry was skipped
    expect(h.groups.activeGroup.activeEditor).toBeUndefined()
    d.dispose()
    h.groups.dispose()
    h.closedSvc.dispose()
  })
})
