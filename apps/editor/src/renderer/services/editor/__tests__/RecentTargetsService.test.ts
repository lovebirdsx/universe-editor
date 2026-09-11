/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for RecentTargetsService — the unified editor+view MRU behind Ctrl+Tab.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  PartId,
  URI,
  ViewContainerLocation,
  type IFocusEntry,
  type IFocusStackService,
  type IStorageService as IStorageServiceType,
  type IViewContainerDescriptor,
  type IViewDescriptor,
  type IViewDescriptorService,
  type IViewState,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import {
  decodeEditorPickId,
  decodeViewPickId,
  encodeEditorPickId,
  encodeViewPickId,
  RecentTargetsService,
  type IGetRecentTargetsOptions,
} from '../RecentTargetsService.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class StableInput extends EditorInput {
  static readonly TYPE_ID = 'stable.recent.test'

  static deserialize(data: unknown): StableInput {
    return new StableInput((data as { uri: string }).uri)
  }

  constructor(private readonly _uri: string) {
    super()
  }
  override get typeId(): string {
    return StableInput.TYPE_ID
  }
  override get resource(): URI {
    return URI.parse(this._uri)
  }
  override getName(): string {
    return this._uri
  }
  override serialize(): { uri: string } {
    return { uri: this._uri }
  }
}

function makeInput(name: string): StableInput {
  return new StableInput(`test:///${name}`)
}

/** Minimal focus stack: tests drive it by calling `push` directly. */
class FakeFocusStackService implements IFocusStackService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event
  private _top: IFocusEntry | undefined

  push(entry: Omit<IFocusEntry, 'timestamp'>): void {
    this._top = { ...entry, timestamp: 0 }
    this._onDidChange.fire()
  }
  /** Focus landing somewhere with no enclosing view (editor area, activity bar). */
  pushNonView(partId: PartId): void {
    this.push({ partId })
  }
  getTop(): IFocusEntry | undefined {
    return this._top
  }
  getAll(): readonly IFocusEntry[] {
    return this._top ? [this._top] : []
  }
  nextPart(): PartId | undefined {
    return undefined
  }
  previousPart(): PartId | undefined {
    return undefined
  }
  clear(): void {
    this._top = undefined
  }
}

/**
 * Only the read paths RecentTargetsService uses. `views` holds what
 * getViewsByContainer would return — i.e. already `when`-gated, matching the
 * real service's contract.
 */
class FakeViewDescriptorService implements Partial<IViewDescriptorService> {
  declare readonly _serviceBrand: undefined
  private readonly _containers = new Map<ViewContainerLocation, IViewContainerDescriptor[]>()
  private readonly _views = new Map<string, IViewDescriptor[]>()

  addContainer(
    location: ViewContainerLocation,
    containerId: string,
    viewIds: readonly string[],
  ): void {
    const container = {
      id: containerId,
      label: containerId,
      icon: 'files',
      order: 0,
      location,
    } satisfies IViewContainerDescriptor
    const list = this._containers.get(location) ?? []
    list.push(container)
    this._containers.set(location, list)
    this._views.set(
      containerId,
      viewIds.map((id, order) => ({
        id,
        name: id,
        containerId,
        componentKey: id,
        order,
      })),
    )
  }

  /** Simulates a `when` clause flipping false: the view stops being returned. */
  hideView(containerId: string, viewId: string): void {
    const list = this._views.get(containerId) ?? []
    this._views.set(
      containerId,
      list.filter((v) => v.id !== viewId),
    )
  }

  getViewContainersByLocation(
    location: ViewContainerLocation,
  ): readonly IViewContainerDescriptor[] {
    return this._containers.get(location) ?? []
  }
  getViewsByContainer(containerId: string): readonly IViewDescriptor[] {
    return this._views.get(containerId) ?? []
  }
  getViewContainerByViewId(viewId: string): IViewContainerDescriptor | undefined {
    for (const [location, containers] of this._containers) {
      void location
      for (const c of containers) {
        if (this.getViewsByContainer(c.id).some((v) => v.id === viewId)) return c
      }
    }
    return undefined
  }
  getViewState(): IViewState {
    return {}
  }
}

/**
 * JSON round-tripping IStorageService, so a value that only survives in memory
 * fails loudly. `swapWorkspaceScope` mimics the main-side backend swap that an
 * openFolder/closeFolder triggers.
 */
class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private _data = new Map<string, unknown>()
  private readonly _scopeEmitter = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._scopeEmitter.event
  writes = 0

  async get<T>(key: string): Promise<T | undefined> {
    return this._data.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.writes++
    this._data.set(key, JSON.parse(JSON.stringify(value)))
  }
  async remove(key: string): Promise<void> {
    this._data.delete(key)
  }
  seed(key: string, value: unknown): void {
    this._data.set(key, JSON.parse(JSON.stringify(value)))
  }
  swapWorkspaceScope(): void {
    this._data = new Map()
    this._scopeEmitter.fire()
  }
}

const STORAGE_KEY = 'workbench.recentTargets'

/** Persisted entry for an editor, as the service writes it. */
function persistedEditor(input: EditorInput): { kind: 'editor'; id: string } {
  return { kind: 'editor', id: input.id }
}

interface Harness {
  groups: EditorGroupsService
  views: FakeViewDescriptorService
  focus: FakeFocusStackService
  storage: FakeStorage
  svc: RecentTargetsService
  dispose(): void
}

function makeService(
  configure?: (views: FakeViewDescriptorService) => void,
  groups = new EditorGroupsService(),
  storage = new FakeStorage(),
): Harness {
  const views = new FakeViewDescriptorService()
  configure?.(views)
  const focus = new FakeFocusStackService()
  const svc = new RecentTargetsService(
    groups,
    views as unknown as IViewDescriptorService,
    focus as unknown as IFocusStackService,
    storage,
    null!,
  )
  svc._setPersistDebounceMsForTests(0)
  return {
    groups,
    views,
    focus,
    storage,
    svc,
    dispose: () => {
      svc.dispose()
      groups.dispose()
    },
  }
}

/** Lets the storage read (and any debounced write) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Stable identity per target, for order assertions. */
function keysOf(svc: RecentTargetsService, options?: IGetRecentTargetsOptions): string[] {
  return svc.getRecentTargets(options).map((t) => {
    if (t.kind === 'view') return encodeViewPickId(t.descriptor.id)
    if (t.kind === 'closedEditor') return t.editorId
    return encodeEditorPickId(t.group.id, t.editor.id)
  })
}

let cleanupRegistry: (() => void) | undefined

beforeEach(() => {
  const d = EditorRegistry.registerEditorProvider({
    typeId: StableInput.TYPE_ID,
    componentKey: 'stable',
    deserialize: (data) => StableInput.deserialize(data),
  })
  cleanupRegistry = () => d.dispose()
})

afterEach(() => {
  cleanupRegistry?.()
  cleanupRegistry = undefined
})

// ---------------------------------------------------------------------------
// Pick id encoding
// ---------------------------------------------------------------------------

describe('RecentTargetsService — pick id encoding', () => {
  it('round-trips a view id', () => {
    const id = encodeViewPickId('workbench.view.explorer.tree')
    expect(decodeViewPickId(id)).toBe('workbench.view.explorer.tree')
  })

  it('round-trips an editor id', () => {
    const id = encodeEditorPickId(3, 'abc')
    expect(decodeEditorPickId(id)).toEqual({ groupId: 3, editorId: 'abc' })
  })

  it('the two prefixes are mutually exclusive', () => {
    expect(decodeViewPickId(encodeEditorPickId(0, 'abc'))).toBeUndefined()
    expect(decodeEditorPickId(encodeViewPickId('some.view'))).toBeUndefined()
  })

  it('rejects a view id with an empty body', () => {
    expect(decodeViewPickId('view::')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Editor MRU (behaviour carried over from the editor-only service)
// ---------------------------------------------------------------------------

describe('RecentTargetsService — editor MRU', () => {
  it('returns empty list when nothing is open and no views exist', () => {
    const h = makeService()
    expect(h.svc.getRecentTargets()).toHaveLength(0)
    h.dispose()
  })

  it('lists the active editor after it is opened', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    groups.activeGroup.openEditor(a)
    const h = makeService(undefined, groups)
    const recent = h.svc.getRecentTargets()
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ kind: 'editor' })
    expect(recent[0]!.kind === 'editor' && recent[0]!.editor.id).toBe(a.id)
    h.dispose()
  })

  it('most-recently-activated editor appears first', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    const h = makeService(undefined, groups)

    groups.activeGroup.setActive(a)
    expect(keysOf(h.svc)).toEqual([
      encodeEditorPickId(groups.activeGroup.id, a.id),
      encodeEditorPickId(groups.activeGroup.id, b.id),
    ])
    h.dispose()
  })

  it('closed editor drops out of the list', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    const h = makeService(undefined, groups)
    groups.activeGroup.closeEditor(b)
    expect(keysOf(h.svc)).not.toContain(encodeEditorPickId(groups.activeGroup.id, b.id))
    h.dispose()
  })

  it('includes background editors restored from a previous session', () => {
    const src = new EditorGroupsService()
    const active = makeInput('active')
    const bg1 = makeInput('bg1')
    const bg2 = makeInput('bg2')
    src.activeGroup.openEditor(active)
    src.activeGroup.openEditor(bg1, { activate: false })
    src.activeGroup.openEditor(bg2, { activate: false })
    const state = src.toJSON()
    src.dispose()

    // Service constructed BEFORE restore, matching the boot order in main.tsx.
    const dst = new EditorGroupsService()
    const h = makeService(undefined, dst)
    dst.restore(state)

    const recent = h.svc.getRecentTargets()
    expect(recent).toHaveLength(3)
    expect(recent[0]!.kind === 'editor' && recent[0]!.editor.id).toBe(active.id)
    h.dispose()
  })

  it('includes background editors across multiple restored groups', () => {
    const src = new EditorGroupsService()
    src.activeGroup.openEditor(makeInput('g1-active'))
    src.activeGroup.openEditor(makeInput('g1-bg'), { activate: false })
    const g2 = src.addGroup(src.activeGroup, GroupDirection.Right)
    g2.openEditor(makeInput('g2-active'))
    g2.openEditor(makeInput('g2-bg'), { activate: false })
    const state = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    const h = makeService(undefined, dst)
    dst.restore(state)

    expect(h.svc.getRecentTargets()).toHaveLength(4)
    h.dispose()
  })
})

// ---------------------------------------------------------------------------
// Views in the list
// ---------------------------------------------------------------------------

describe('RecentTargetsService — views', () => {
  it('lists every visible view even when none was ever focused', () => {
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree', 'timeline'])
      v.addContainer(ViewContainerLocation.Panel, 'panel', ['terminal'])
    })
    expect(keysOf(h.svc)).toEqual([
      encodeViewPickId('tree'),
      encodeViewPickId('timeline'),
      encodeViewPickId('terminal'),
    ])
    h.dispose()
  })

  it('interleaves editors and views by recency', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree'])
    }, groups)

    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    groups.activeGroup.openEditor(b)

    expect(keysOf(h.svc)).toEqual([
      encodeEditorPickId(groups.activeGroup.id, b.id),
      encodeViewPickId('tree'),
      encodeEditorPickId(groups.activeGroup.id, a.id),
    ])
    h.dispose()
  })

  it('re-focusing a view bubbles it back to the head', () => {
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree', 'timeline'])
    })
    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    h.focus.push({ partId: PartId.SideBar, viewId: 'timeline' })
    expect(keysOf(h.svc)[0]).toBe(encodeViewPickId('timeline'))

    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    expect(keysOf(h.svc)[0]).toBe(encodeViewPickId('tree'))
    h.dispose()
  })

  it('ignores focus entries that carry no view id', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    groups.activeGroup.openEditor(a)
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree'])
    }, groups)

    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    h.focus.pushNonView(PartId.EditorArea)

    // The editor-area focus must not displace the view at the MRU head.
    expect(keysOf(h.svc)[0]).toBe(encodeViewPickId('tree'))
    h.dispose()
  })

  it('drops a view that is no longer visible, even if it was focused', () => {
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree', 'timeline'])
    })
    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    expect(keysOf(h.svc)).toContain(encodeViewPickId('tree'))

    h.views.hideView('explorer', 'tree')
    expect(keysOf(h.svc)).not.toContain(encodeViewPickId('tree'))
    h.dispose()
  })

  it('lists every visible view past the MRU depth bound', () => {
    // The MRU remembers a bounded history; the picker list must not inherit
    // that bound — everything switchable stays reachable.
    const ids = Array.from({ length: 60 }, (_, i) => `view-${i}`)
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'many', ids)
    })
    for (const id of ids) h.focus.push({ partId: PartId.SideBar, viewId: id })

    const keys = keysOf(h.svc)
    expect(keys).toHaveLength(60)
    for (const id of ids) expect(keys).toContain(encodeViewPickId(id))
    h.dispose()
  })
})

// The view-only projection Ctrl+P consumes: same ordering as getRecentTargets,
// with the editors dropped rather than a second traversal that could drift.
describe('RecentTargetsService — getRecentViews', () => {
  it('orders views by recency, never-focused ones last', () => {
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree', 'timeline'])
      v.addContainer(ViewContainerLocation.Panel, 'panel', ['terminal'])
    })
    h.focus.push({ partId: PartId.SideBar, viewId: 'timeline' })

    expect(h.svc.getRecentViews().map((d) => d.id)).toEqual(['timeline', 'tree', 'terminal'])
    h.dispose()
  })

  it('omits editors even when they head the MRU', () => {
    const groups = new EditorGroupsService()
    groups.activeGroup.openEditor(makeInput('a'))
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree'])
    }, groups)

    expect(h.svc.getRecentViews().map((d) => d.id)).toEqual(['tree'])
    h.dispose()
  })

  it('omits a view that is no longer visible', () => {
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree', 'timeline'])
    })
    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })

    h.views.hideView('explorer', 'tree')
    expect(h.svc.getRecentViews().map((d) => d.id)).toEqual(['timeline'])
    h.dispose()
  })
})

// ---------------------------------------------------------------------------
// Closed editor slots — the Ctrl+P half of the story: a file the user just
// closed must keep the place it held instead of sinking below views that were
// touched longer ago, so its slot is reported rather than dropped.
// ---------------------------------------------------------------------------

describe('RecentTargetsService — closed editor slots', () => {
  it('stays silent about a closed editor unless the caller asks', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    const h = makeService(undefined, groups)

    groups.activeGroup.closeEditor(b)

    expect(keysOf(h.svc)).not.toContain(b.id)
    expect(keysOf(h.svc, { includeClosedEditors: true })).toContain(b.id)
    h.dispose()
  })

  it('reports the closed editor at the recency slot it held while open', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    const c = makeInput('c')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.openEditor(c)
    const h = makeService((v) => {
      v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree'])
    }, groups)

    // Working in the search view, then closing the file that was open before it:
    // the slot must sit under the new active editor and *above* the older editor,
    // while the view keeps the recency it earned.
    h.focus.push({ partId: PartId.SideBar, viewId: 'tree' })
    groups.activeGroup.closeEditor(c)

    expect(keysOf(h.svc, { includeClosedEditors: true })).toEqual([
      encodeEditorPickId(groups.activeGroup.id, b.id),
      encodeViewPickId('tree'),
      c.id,
      encodeEditorPickId(groups.activeGroup.id, a.id),
    ])
    h.dispose()
  })

  it('does not report a slot for an editor that is still open in another group', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const first = groups.activeGroup
    first.openEditor(a)
    const second = groups.addGroup(first, GroupDirection.Right)
    second.openEditor(a)
    const h = makeService(undefined, groups)

    first.closeEditor(a)

    expect(keysOf(h.svc)).toEqual([encodeEditorPickId(second.id, a.id)])
    expect(keysOf(h.svc, { includeClosedEditors: true })).toEqual([
      encodeEditorPickId(second.id, a.id),
    ])
    h.dispose()
  })
})

// ---------------------------------------------------------------------------
// Persisted history — the Ctrl+Tab half: the order must survive a workspace
// restart instead of degrading to the tab order the restore reproduces.
// ---------------------------------------------------------------------------

/** Restored grid with tabs in `order`, first one active — the tab order a
 *  restore reproduces, deliberately the reverse of the persisted recency. */
function restoreGrid(inputs: readonly EditorInput[]): EditorGroupsService {
  const groups = new EditorGroupsService()
  const [first, ...rest] = inputs
  if (first) groups.activeGroup.openEditor(first)
  for (const input of rest) groups.activeGroup.openEditor(input, { activate: false })
  return groups
}

describe('RecentTargetsService — persisted history', () => {
  it('folds the persisted order in after the grid is restored', async () => {
    const storage = new FakeStorage()
    const a = makeInput('a')
    const b = makeInput('b')
    const c = makeInput('c')
    // Last session ended with c most recent, then b, then a.
    storage.seed(STORAGE_KEY, [persistedEditor(c), persistedEditor(b), persistedEditor(a)])

    const groups = new EditorGroupsService()
    const h = makeService(undefined, groups, storage)
    groups.restore(restoreGrid([a, b, c]).toJSON())
    await flush()
    h.svc.rebaseAfterRestore()

    const { id } = groups.activeGroup
    expect(keysOf(h.svc).slice(0, 3)).toEqual([
      encodeEditorPickId(id, c.id),
      encodeEditorPickId(id, b.id),
      encodeEditorPickId(id, a.id),
    ])
    h.dispose()
  })

  it('re-anchors persisted editors to whichever group holds them now', async () => {
    const storage = new FakeStorage()
    const a = makeInput('a')
    storage.seed(STORAGE_KEY, [persistedEditor(a)])

    const groups = new EditorGroupsService()
    const h = makeService(undefined, groups, storage)
    groups.restore(restoreGrid([a]).toJSON())
    await flush()
    h.svc.rebaseAfterRestore()

    // A live editor, not a dead slot: group ids are a process-global counter, so
    // the restored group id is not the one the previous session had.
    expect(h.svc.getRecentTargets({ includeClosedEditors: true })[0]).toMatchObject({
      kind: 'editor',
      group: { id: groups.activeGroup.id },
    })
    h.dispose()
  })

  it('leaves the history pending until the grid is restored', async () => {
    const storage = new FakeStorage()
    const a = makeInput('a')
    const b = makeInput('b')
    storage.seed(STORAGE_KEY, [persistedEditor(b), persistedEditor(a)])

    const groups = new EditorGroupsService()
    const h = makeService(undefined, groups, storage)
    await flush()
    // Folding now would resolve every editor against an empty grid and turn the
    // whole history into dead slots.
    expect(keysOf(h.svc, { includeClosedEditors: true })).toEqual([])

    groups.restore(restoreGrid([a, b]).toJSON())
    h.svc.rebaseAfterRestore()

    const { id } = groups.activeGroup
    expect(keysOf(h.svc).slice(0, 2)).toEqual([
      encodeEditorPickId(id, b.id),
      encodeEditorPickId(id, a.id),
    ])
    h.dispose()
  })

  it('keeps view entries and parks history editors that are gone as dead slots', async () => {
    const storage = new FakeStorage()
    const gone = makeInput('gone')
    storage.seed(STORAGE_KEY, [{ kind: 'view', id: 'tree' }, persistedEditor(gone)])

    const h = makeService(
      (v) => {
        v.addContainer(ViewContainerLocation.SideBar, 'explorer', ['tree'])
      },
      undefined,
      storage,
    )
    await flush()
    h.svc.rebaseAfterRestore()

    expect(keysOf(h.svc)).toEqual([encodeViewPickId('tree')])
    // The slot survives, so a caller listing closed editors can still place it.
    expect(keysOf(h.svc, { includeClosedEditors: true })).toEqual([
      encodeViewPickId('tree'),
      gone.id,
    ])
    h.dispose()
  })

  it('folds once, letting later touches stay ahead of the history', async () => {
    const storage = new FakeStorage()
    const a = makeInput('a')
    const b = makeInput('b')
    storage.seed(STORAGE_KEY, [persistedEditor(b), persistedEditor(a)])

    const groups = new EditorGroupsService()
    const h = makeService(undefined, groups, storage)
    groups.restore(restoreGrid([a, b]).toJSON())
    await flush()
    h.svc.rebaseAfterRestore()

    const { id } = groups.activeGroup
    groups.activeGroup.setActive(b)
    h.svc.rebaseAfterRestore()
    h.svc.getRecentViews()

    expect(keysOf(h.svc)).toEqual([encodeEditorPickId(id, b.id), encodeEditorPickId(id, a.id)])
    h.dispose()
  })

  it('drops the outgoing workspace history when the storage scope swaps', async () => {
    const storage = new FakeStorage()
    const a = makeInput('a')
    const b = makeInput('b')
    storage.seed(STORAGE_KEY, [persistedEditor(b), persistedEditor(a)])

    const groups = new EditorGroupsService()
    const h = makeService(undefined, groups, storage)
    groups.restore(restoreGrid([a, b]).toJSON())
    await flush()
    h.svc.rebaseAfterRestore()

    const { id } = groups.activeGroup
    expect(keysOf(h.svc).slice(0, 2)).toEqual([
      encodeEditorPickId(id, b.id),
      encodeEditorPickId(id, a.id),
    ])

    storage.swapWorkspaceScope()
    await flush()
    h.svc.rebaseAfterRestore()

    // The new workspace has no history of its own: recency starts from the grid.
    expect(keysOf(h.svc).slice(0, 2)).toEqual([
      encodeEditorPickId(id, a.id),
      encodeEditorPickId(id, b.id),
    ])
    h.dispose()
  })

  it('persists recency most-recent-first', async () => {
    const storage = new FakeStorage()
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    const h = makeService(undefined, groups, storage)

    await flush()
    groups.activeGroup.setActive(a)
    await flush()

    expect(await storage.get(STORAGE_KEY)).toEqual([persistedEditor(a), persistedEditor(b)])
    h.dispose()
  })

  it('keeps this session’s entries when the history alone fills the bound', async () => {
    const storage = new FakeStorage()
    const history = Array.from({ length: 50 }, (_, i) => ({
      kind: 'editor' as const,
      id: `test:///old-${i}`,
    }))
    storage.seed(STORAGE_KEY, history)

    const groups = new EditorGroupsService()
    // The service exists before the editors are opened, as it does in the app.
    const h = makeService(undefined, groups, storage)
    const fresh = [makeInput('new-0'), makeInput('new-1'), makeInput('new-2')]
    for (const input of fresh) groups.activeGroup.openEditor(input)
    await flush()

    const { id } = groups.activeGroup
    const keys = keysOf(h.svc, { includeClosedEditors: true })
    expect(keys).toHaveLength(50)
    expect(keys.slice(0, 3)).toEqual([
      encodeEditorPickId(id, fresh[2]!.id),
      encodeEditorPickId(id, fresh[1]!.id),
      encodeEditorPickId(id, fresh[0]!.id),
    ])
    // The oldest history entries are what gives way.
    expect(keys).toContain('test:///old-46')
    expect(keys).not.toContain('test:///old-49')
    h.dispose()
  })
})
