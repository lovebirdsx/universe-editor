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

interface Harness {
  groups: EditorGroupsService
  views: FakeViewDescriptorService
  focus: FakeFocusStackService
  svc: RecentTargetsService
  dispose(): void
}

function makeService(
  configure?: (views: FakeViewDescriptorService) => void,
  groups = new EditorGroupsService(),
): Harness {
  const views = new FakeViewDescriptorService()
  configure?.(views)
  const focus = new FakeFocusStackService()
  const svc = new RecentTargetsService(
    groups,
    views as unknown as IViewDescriptorService,
    focus as unknown as IFocusStackService,
  )
  return {
    groups,
    views,
    focus,
    svc,
    dispose: () => {
      svc.dispose()
      groups.dispose()
    },
  }
}

/** Stable identity per target, for order assertions. */
function keysOf(svc: RecentTargetsService): string[] {
  return svc.getRecentTargets().map((t) => {
    return t.kind === 'view'
      ? encodeViewPickId(t.descriptor.id)
      : encodeEditorPickId(t.group.id, t.editor.id)
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
