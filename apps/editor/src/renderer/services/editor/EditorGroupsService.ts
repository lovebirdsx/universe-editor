/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupsService — DI entry, grid coordination, and serialize/restore.
 *  The EditorGroup adapter lives in EditorGroup.ts and the serialization
 *  schema in editorGroupsPersistence.ts; both are re-exported from this file
 *  so existing imports keep working.
 *--------------------------------------------------------------------------------------------*/

import {
  Direction,
  Disposable,
  EditorGroupModel,
  EditorInput,
  EditorRegistry,
  Emitter,
  Event,
  GroupDirection,
  GroupLocation,
  GroupOrientation,
  GroupsArrangement,
  GroupsOrder,
  Grid,
  type GridBranchNode,
  type GridNode,
  type GridLeafNode,
  IEditorGroup,
  IEditorGroupsService,
  IFindGroupScope,
  NullLogger,
  type ISerializedGrid,
  Orientation,
  type ServicesAccessor,
  observableValue,
  transaction,
  type ILogger,
  type IDisposable,
} from '@universe-editor/platform'
import { EditorGroup, directionToGridDirection } from './EditorGroup.js'
import { EditorViewStateCache } from './EditorViewStateCache.js'
import {
  collectLeavesInOrder,
  type ICollectedLeaf,
  type ISerializedEditorGroupData,
  type ISerializedEditorGroupsState,
} from './editorGroupsPersistence.js'

export { EditorGroup } from './EditorGroup.js'
export type {
  ISerializedEditorGroupData,
  ISerializedEditorGroupsState,
  ISerializedEditorInputData,
} from './editorGroupsPersistence.js'

export class EditorGroupsService extends Disposable implements IEditorGroupsService {
  declare readonly _serviceBrand: undefined

  private readonly _grid: Grid<EditorGroup>
  private readonly _groups: EditorGroup[] = []
  private readonly _mru: EditorGroup[] = []
  private _orientation: GroupOrientation = GroupOrientation.Horizontal
  private readonly _groupWatchers = new Map<number, IDisposable>()

  private readonly _activeGroup: ReturnType<typeof observableValue<EditorGroup>>

  private readonly _onDidActiveGroupChange = this._register(new Emitter<IEditorGroup>())
  readonly onDidActiveGroupChange: Event<IEditorGroup> = this._onDidActiveGroupChange.event

  private readonly _onDidAddGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidAddGroup: Event<IEditorGroup> = this._onDidAddGroup.event

  private readonly _onDidRemoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidRemoveGroup: Event<IEditorGroup> = this._onDidRemoveGroup.event

  private readonly _onDidMoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidMoveGroup: Event<IEditorGroup> = this._onDidMoveGroup.event

  /** Public grid handle for the React layer to subscribe / introspect. */
  get grid(): Grid<EditorGroup> {
    return this._grid
  }

  constructor(private readonly _logger: ILogger = new NullLogger()) {
    super()
    const initial = new EditorGroup(this._register(new EditorGroupModel()), this)
    this._groups.push(initial)
    this._mru.push(initial)
    this._grid = new Grid<EditorGroup>(initial, Orientation.Horizontal)
    this._activeGroup = observableValue<EditorGroup>('activeGroup', initial)
    this._watchGroup(initial)
    this._register({
      dispose: () => {
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
      },
    })
  }

  get activeGroup(): IEditorGroup {
    return this._activeGroup.get()
  }

  get activeGroupForOpen(): IEditorGroup {
    const active = this._activeGroup.get()
    if (!active.isLocked) return active
    const unlocked = this._groups.find((g) => !g.isLocked)
    if (unlocked) return unlocked
    // Every group is locked — open into a fresh, unlocked group next to the
    // active one and make it the active target (VSCode parity).
    const created = this.addGroup(active, GroupDirection.Right)
    this.activateGroup(created)
    return created
  }

  get groups(): readonly IEditorGroup[] {
    return this._groups
  }

  get count(): number {
    return this._groups.length
  }

  get orientation(): GroupOrientation {
    return this._orientation
  }

  getGroup(id: number): IEditorGroup | undefined {
    return this._groups.find((g) => g.id === id)
  }

  getGroups(order: GroupsOrder = GroupsOrder.CreationTime): readonly IEditorGroup[] {
    if (order === GroupsOrder.MostRecentlyActive) return this._mru.slice()
    return this._groups.slice()
  }

  findGroup(
    scope: IFindGroupScope,
    source: IEditorGroup = this.activeGroup,
    wrap = false,
  ): IEditorGroup | undefined {
    const idx = this._groups.indexOf(source as EditorGroup)
    if (idx === -1) return undefined
    if (scope.location !== undefined) {
      switch (scope.location) {
        case GroupLocation.First:
          return this._groups[0]
        case GroupLocation.Last:
          return this._groups[this._groups.length - 1]
        case GroupLocation.Next: {
          const next = idx + 1
          if (next < this._groups.length) return this._groups[next]
          return wrap ? this._groups[0] : undefined
        }
        case GroupLocation.Previous: {
          const prev = idx - 1
          if (prev >= 0) return this._groups[prev]
          return wrap ? this._groups[this._groups.length - 1] : undefined
        }
      }
    }
    if (scope.direction !== undefined) {
      return this._findSpatialNeighbor(source as EditorGroup, scope.direction)
    }
    return undefined
  }

  private _findSpatialNeighbor(
    source: EditorGroup,
    direction: GroupDirection,
  ): EditorGroup | undefined {
    const gridDir = directionToGridDirection(direction)
    const wantedOrientation =
      gridDir === Direction.Left || gridDir === Direction.Right
        ? Orientation.Horizontal
        : Orientation.Vertical
    const goForward = gridDir === Direction.Right || gridDir === Direction.Down

    function findLeaf(node: GridNode<EditorGroup>): GridLeafNode<EditorGroup> | undefined {
      if (node.kind === 'leaf') return node.view === source ? node : undefined
      for (const c of node.children) {
        const f = findLeaf(c)
        if (f) return f
      }
      return undefined
    }

    function nearestLeaf(
      node: GridNode<EditorGroup>,
      last: boolean,
    ): GridLeafNode<EditorGroup> | undefined {
      if (node.kind === 'leaf') return node
      const children = node.children
      if (children.length === 0) return undefined
      return nearestLeaf(last ? children[children.length - 1]! : children[0]!, last)
    }

    const leaf = findLeaf(this._grid.root)
    if (!leaf) return undefined

    let cur: GridNode<EditorGroup> = leaf
    while (cur.parent) {
      const parent: GridBranchNode<EditorGroup> = cur.parent
      if (parent.orientation === wantedOrientation) {
        const idx = parent.children.indexOf(cur)
        const sibIdx = goForward ? idx + 1 : idx - 1
        if (sibIdx >= 0 && sibIdx < parent.children.length) {
          return nearestLeaf(parent.children[sibIdx]!, goForward)?.view
        }
      }
      cur = parent
    }
    return undefined
  }

  activateGroup(group: IEditorGroup | number): IEditorGroup {
    const target = this._resolve(group)
    if (!target) return this.activeGroup
    if (this.activeGroup === target) return target
    transaction((tx) => {
      this._activeGroup.set(target, tx)
    })
    // MRU bump
    const idx = this._mru.indexOf(target)
    if (idx !== -1) this._mru.splice(idx, 1)
    this._mru.unshift(target)
    this._onDidActiveGroupChange.fire(target)
    this._logger.debug(`activateGroup id=${target.id}`)
    return target
  }

  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup {
    const target = this._resolve(location) ?? (this.activeGroup as EditorGroup)
    const newGroup = new EditorGroup(this._register(new EditorGroupModel()), this)
    this._grid.addView(newGroup, 200, target as EditorGroup, directionToGridDirection(direction))
    this._groups.push(newGroup)
    this._mru.push(newGroup)
    this._onDidAddGroup.fire(newGroup)
    this._watchGroup(newGroup)
    this._logger.info(`addGroup id=${newGroup.id} target=${target.id} direction=${direction}`)
    return newGroup
  }

  removeGroup(group: IEditorGroup | number): void {
    if (this._groups.length <= 1) return // protect: keep at least one group
    const target = this._resolve(group)
    if (!target) return
    this._groupWatchers.get(target.id)?.dispose()
    this._groupWatchers.delete(target.id)
    this._grid.removeView(target)
    const idx = this._groups.indexOf(target)
    if (idx !== -1) this._groups.splice(idx, 1)
    const mruIdx = this._mru.indexOf(target)
    if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
    if (this.activeGroup === target) {
      const next = this._mru[0] ?? this._groups[0]!
      this._activeGroup.set(next, undefined)
      this._onDidActiveGroupChange.fire(next)
    }
    target.model.dispose()
    this._onDidRemoveGroup.fire(target)
    this._logger.info(`removeGroup id=${target.id}`)
  }

  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup {
    const src = group as EditorGroup
    const dst = location as EditorGroup
    if (src === dst) return src
    this._grid.moveView(src, dst, directionToGridDirection(direction))
    this._onDidMoveGroup.fire(src)
    this._logger.info(`moveGroup id=${src.id} target=${dst.id} direction=${direction}`)
    return src
  }

  moveEditor(editor: EditorInput, target: IEditorGroup): void {
    const src = this._findGroupContaining(editor)
    if (!src) return
    if (src === target) return
    src.detachEditor(editor)
    // If the target already holds a same-id editor (e.g. a split clone),
    // openEditor keeps the existing one and disposes this orphan for us — no
    // extra guard needed here.
    ;(target as EditorGroup).openEditor(editor)
    this._logger.info(`moveEditor id=${editor.id} from=${src.id} to=${target.id}`)
  }

  copyEditor(editor: EditorInput, target: IEditorGroup): void {
    ;(target as EditorGroup).openEditor(editor)
    this._logger.info(`copyEditor id=${editor.id} to=${target.id}`)
  }

  setGroupOrientation(orientation: GroupOrientation): void {
    this._orientation = orientation
    this._logger.debug(`setGroupOrientation orientation=${orientation}`)
  }

  arrangeGroups(_arrangement: GroupsArrangement, _group?: IEditorGroup): void {
    // No-op for the simplified renderer; the grid layout reflows automatically.
  }

  // Helpers ------------------------------------------------------------------

  private _watchGroup(group: EditorGroup): void {
    const d = this._register(
      group.model.onDidChangeModel(() => {
        if (group.count === 0 && this._groups.length > 1) {
          queueMicrotask(() => {
            if (group.count === 0 && this._groups.includes(group)) {
              this.removeGroup(group)
            }
          })
        }
      }),
    )
    this._groupWatchers.set(group.id, d)
  }

  private _resolve(group: IEditorGroup | number): EditorGroup | undefined {
    if (typeof group === 'number') return this._groups.find((g) => g.id === group)
    return group as EditorGroup
  }

  private _findGroupContaining(editor: EditorInput): EditorGroup | undefined {
    for (const g of this._groups) {
      if (g.contains(editor)) return g
    }
    return undefined
  }

  // Persistence --------------------------------------------------------------

  toJSON(): ISerializedEditorGroupsState {
    const grid = this._grid.serialize((group) => {
      const persistable = group.editors
      const activeIdx = group.activeEditor ? persistable.indexOf(group.activeEditor) : -1
      const uris = persistable.map((e) => e.resource?.toString() ?? '').filter(Boolean)
      const viewStates = EditorViewStateCache.snapshotGroup(group.id, uris)
      return {
        editors: persistable.map((e) => ({
          typeId: e.typeId,
          data: e.serialize?.() ?? null,
        })),
        activeIndex: activeIdx >= 0 ? activeIdx : 0,
        ...(group.isLocked ? { locked: true } : {}),
        ...(Object.keys(viewStates).length > 0 && { viewStates }),
      }
    }) as ISerializedGrid<ISerializedEditorGroupData>
    const activeId = this.activeGroup.id
    return { grid, activeGroupId: activeId }
  }

  /**
   * Replace the current grid + groups with the contents of `state`. Existing
   * editors are closed and groups disposed; the React tree continues to track
   * the same `_grid` object, since views are added/removed via the grid's
   * public API so its `onDidChange` event keeps GridLayout in sync.
   *
   * Unknown editor `typeId`s are skipped silently (forward-compatibility with
   * future editor providers that may not be registered on older builds).
   *
   * The optional `accessor` is forwarded to `EditorRegistry.deserialize` so
   * providers that need to construct service-dependent inputs (e.g. the file
   * editor needing `IFileService`) can reach the DI graph.
   */
  restore(state: ISerializedEditorGroupsState, accessor?: ServicesAccessor): void {
    // 1. Tear down existing groups beyond the first; close all editors in the
    //    first group so it can be reused as the seed leaf.  We do NOT call
    //    grid.removeView here because the grid will be fully rebuilt in step 4.
    for (let i = this._groups.length - 1; i >= 1; i--) {
      const g = this._groups[i]!
      this._groupWatchers.get(g.id)?.dispose()
      this._groupWatchers.delete(g.id)
      this._groups.splice(i, 1)
      const mruIdx = this._mru.indexOf(g)
      if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
      g.model.dispose()
      this._onDidRemoveGroup.fire(g)
    }
    const seed = this._groups[0]!
    seed.closeAllEditors()

    // 2. Walk the serialized tree to collect all leaves in pre-order.
    const visitOrder: ICollectedLeaf[] = []
    collectLeavesInOrder(state.grid.root, undefined, visitOrder)

    // 3. Create EditorGroup instances for each leaf (reuse the seed for the first).
    const leafGroups: EditorGroup[] = []
    for (let i = 0; i < visitOrder.length; i++) {
      if (i === 0) {
        leafGroups.push(seed)
      } else {
        const newGroup = new EditorGroup(this._register(new EditorGroupModel()), this)
        leafGroups.push(newGroup)
        this._groups.push(newGroup)
        this._mru.push(newGroup)
        this._watchGroup(newGroup)
      }
    }

    // 4. Rebuild the grid tree from the serialized structure in one shot.
    //    This correctly restores every level of nesting (branch orientations,
    //    depths) unlike the previous sequential addView approach which could
    //    not express trees where a branch node is the sibling of a leaf at
    //    any nesting depth greater than one.
    let leafIndex = 0
    this._grid.rebuildFrom(state.grid.root, (_data: unknown) => leafGroups[leafIndex++]!)

    // 5. Fire add events for new groups, then hydrate editors.
    let restoredActive: EditorGroup | undefined
    visitOrder.forEach((leaf, index) => {
      const target = leafGroups[index]!
      if (index > 0) this._onDidAddGroup.fire(target)
      const hydrated: EditorInput[] = []
      for (const e of leaf.data.editors) {
        const input = EditorRegistry.deserialize(e.typeId, e.data, accessor)
        if (input) hydrated.push(input)
      }
      hydrated.forEach((input) => target.openEditor(input, { activate: false }))
      const activeIdx = Math.min(leaf.data.activeIndex, hydrated.length - 1)
      if (activeIdx >= 0 && hydrated[activeIdx]) target.setActive(hydrated[activeIdx]!)
      // Apply the exact locked state (the reused seed group may carry a stale lock).
      target.lock(leaf.data.locked === true)
      if (leaf.data.viewStates) EditorViewStateCache.restoreGroup(target.id, leaf.data.viewStates)
      if (target.id === state.activeGroupId) restoredActive = target
    })

    // 6. Restore the active group (fall back to the first).
    const nextActive = restoredActive ?? this._groups[0]!
    this._activeGroup.set(nextActive, undefined)
    this._onDidActiveGroupChange.fire(nextActive)
    this._logger.info(`restoreEditorGroups groups=${this._groups.length} active=${nextActive.id}`)
  }

  /**
   * Tear down all groups to a single empty seed group. Used when the active
   * workspace changes and there's no persisted state for the new workspace.
   */
  clearAll(): void {
    for (let i = this._groups.length - 1; i >= 1; i--) {
      const g = this._groups[i]!
      this._grid.removeView(g)
      this._groups.splice(i, 1)
      const mruIdx = this._mru.indexOf(g)
      if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
      g.model.dispose()
      this._onDidRemoveGroup.fire(g)
    }
    const seed = this._groups[0]!
    seed.closeAllEditors()
    seed.lock(false)
    this._activeGroup.set(seed, undefined)
    this._onDidActiveGroupChange.fire(seed)
  }
}
