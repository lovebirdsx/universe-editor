/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorPart — one window's editor layout: grid, groups, active group and MRU.
 *
 *  Extracted from EditorGroupsService so the global service can aggregate a
 *  main part plus auxiliary-window parts without duplicating the single-grid
 *  algorithm. Layout operations are part-scoped; EditorGroupsService keeps the
 *  global (cross-part) enumeration.
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
  NullLogger,
  Orientation,
  transaction,
  observableValue,
  type GridAxis,
  type GridBranchNode,
  type GridLeafNode,
  type GridNode,
  type IDisposable,
  type IEditorGroup,
  type IEditorPart,
  type IFindGroupScope,
  type ILogger,
  type ISerializedGrid,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { EditorGroup, directionToGridDirection } from './EditorGroup.js'
import { DiffEditorInput } from './DiffEditorInput.js'
import { EditorViewStateCache } from './EditorViewStateCache.js'
import {
  collectLeavesInOrder,
  type ICollectedLeaf,
  type ISerializedEditorGroupData,
  type ISerializedEditorGroupsState,
} from './editorGroupsPersistence.js'

/** Hooks the global EditorGroupsService provides back to each part. */
export interface IEditorPartHost {
  /**
   * Explicit group activation (open/reveal intent): retarget new editors to
   * `group` without moving window focus. `previousGroup` is the part's active
   * group before the switch — the part updates its own state first, so the host
   * cannot derive the change by re-reading `part.activeGroup`.
   */
  activateGroup(part: IEditorPart, group: IEditorGroup, previousGroup: IEditorGroup): void
  isPartActive(part: IEditorPart): boolean
}

export interface IEditorPartOptions {
  readonly isMain?: boolean
  readonly logger?: ILogger
}

let nextEditorPartId = 1

export class EditorPart extends Disposable implements IEditorPart {
  readonly id = nextEditorPartId++
  readonly isMain: boolean

  private readonly _grid: Grid<IEditorGroup>
  private readonly _groups: EditorGroup[] = []
  private readonly _mru: EditorGroup[] = []
  private _orientation: GroupOrientation = GroupOrientation.Horizontal
  private readonly _groupWatchers = new Map<number, IDisposable>()
  private readonly _logger: ILogger

  private readonly _activeGroup: ReturnType<typeof observableValue<EditorGroup>>

  private readonly _onDidActiveGroupChange = this._register(new Emitter<IEditorGroup>())
  readonly onDidActiveGroupChange: Event<IEditorGroup> = this._onDidActiveGroupChange.event

  private readonly _onDidAddGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidAddGroup: Event<IEditorGroup> = this._onDidAddGroup.event

  private readonly _onDidRemoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidRemoveGroup: Event<IEditorGroup> = this._onDidRemoveGroup.event

  private readonly _onDidMoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidMoveGroup: Event<IEditorGroup> = this._onDidMoveGroup.event

  constructor(
    private readonly _host: IEditorPartHost,
    options: IEditorPartOptions = {},
  ) {
    super()
    this.isMain = options.isMain === true
    this._logger = options.logger ?? new NullLogger()
    const initial = this._createGroup()
    this._grid = new Grid<IEditorGroup>(initial, Orientation.Horizontal)
    this._activeGroup = observableValue<EditorGroup>('editorPart.activeGroup', initial)
    this._register({
      dispose: () => {
        for (const d of this._groupWatchers.values()) d.dispose()
        this._groupWatchers.clear()
      },
    })
  }

  get grid(): Grid<IEditorGroup> {
    return this._grid
  }

  get isActive(): boolean {
    return this._host.isPartActive(this)
  }

  get isEmpty(): boolean {
    return this._groups.every((g) => g.count === 0)
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
    if (order === GroupsOrder.GridAppearance) return this._grid.getViews().slice()
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

    function findLeaf(node: GridNode<IEditorGroup>): GridLeafNode<IEditorGroup> | undefined {
      if (node.kind === 'leaf') return node.view === source ? node : undefined
      for (const c of node.children) {
        const f = findLeaf(c)
        if (f) return f
      }
      return undefined
    }

    function nearestLeaf(
      node: GridNode<IEditorGroup>,
      last: boolean,
    ): GridLeafNode<IEditorGroup> | undefined {
      if (node.kind === 'leaf') return node
      const children = node.children
      if (children.length === 0) return undefined
      return nearestLeaf(last ? children[children.length - 1]! : children[0]!, last)
    }

    const leaf = findLeaf(this._grid.root)
    if (!leaf) return undefined

    let cur: GridNode<IEditorGroup> = leaf
    while (cur.parent) {
      const parent: GridBranchNode<IEditorGroup> = cur.parent
      if (parent.orientation === wantedOrientation) {
        const idx = parent.children.indexOf(cur)
        const sibIdx = goForward ? idx + 1 : idx - 1
        if (sibIdx >= 0 && sibIdx < parent.children.length) {
          return nearestLeaf(parent.children[sibIdx]!, goForward)?.view as EditorGroup | undefined
        }
      }
      cur = parent
    }
    return undefined
  }

  activateGroup(group: IEditorGroup | number): IEditorGroup {
    const target = this._resolve(group)
    if (!target) return this.activeGroup
    const previousGroup = this.activeGroup
    const groupChanged = previousGroup !== target
    if (groupChanged) {
      transaction((tx) => {
        this._activeGroup.set(target, tx)
      })
      this._bumpMru(target)
    }
    // Explicit activation retargets opens; it is not a window-focus change.
    // `_host.activateGroup` only moves the open target.
    this._host.activateGroup(this, target, previousGroup)
    if (groupChanged) {
      this._onDidActiveGroupChange.fire(target)
      this._logger.debug(`part ${this.id}: activateGroup id=${target.id}`)
    }
    return target
  }

  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup {
    const target = this._resolve(location) ?? (this.activeGroup as EditorGroup)
    const newGroup = this._createGroup()
    this._grid.addView(newGroup, 200, target, directionToGridDirection(direction))
    this._onDidAddGroup.fire(newGroup)
    this._logger.info(
      `part ${this.id}: addGroup id=${newGroup.id} target=${target.id} direction=${direction}`,
    )
    return newGroup
  }

  removeGroup(group: IEditorGroup | number): void {
    if (this._groups.length <= 1) return // protect: keep at least one group per part
    const target = this._resolve(group)
    if (!target) return
    this._groupWatchers.get(target.id)?.dispose()
    this._groupWatchers.delete(target.id)
    this._grid.removeView(target)
    const idx = this._groups.indexOf(target)
    if (idx !== -1) this._groups.splice(idx, 1)
    const mruIdx = this._mru.indexOf(target)
    if (mruIdx !== -1) this._mru.splice(mruIdx, 1)
    if (this._activeGroup.get() === target) {
      const next = this._mru[0] ?? this._groups[0]!
      this._activeGroup.set(next, undefined)
      this._onDidActiveGroupChange.fire(next)
    }
    target.model.dispose()
    this._onDidRemoveGroup.fire(target)
    this._logger.info(`part ${this.id}: removeGroup id=${target.id}`)
  }

  resizeGroup(group: IEditorGroup, axis: GridAxis, deltaPx: number): boolean {
    const target = this._resolve(group)
    if (!target) return false
    const handled = this._grid.resizeViewByDelta(target, axis, deltaPx)
    // Claiming the axis without a usable pixel size looks exactly like a dead
    // shortcut, so say so: the React layer reports the container through
    // `Grid.setContainerSize` and nothing can be converted before it does.
    const container = this._grid.getContainerSize()
    if (handled && (!container || container[axis] <= 0)) {
      this._logger.warn(`part ${this.id}: resizeGroup has no usable ${axis}; resize ignored`)
    }
    return handled
  }

  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup {
    const src = this._resolve(group)
    const dst = this._resolve(location)
    if (!src || !dst || src === dst) return (src ?? group) as IEditorGroup
    this._grid.moveView(src, dst, directionToGridDirection(direction))
    this._onDidMoveGroup.fire(src)
    this._logger.info(`part ${this.id}: moveGroup id=${src.id} target=${dst.id}`)
    return src
  }

  moveEditor(editor: EditorInput, target: IEditorGroup, source?: IEditorGroup): void {
    const dst = this._resolve(target)
    const src = source ? this._resolve(source) : this._groups.find((g) => g.contains(editor))
    if (!src || !dst || src === dst) return
    const actual = src.findEditor(editor)
    if (!actual) return
    const sticky = src.isSticky(actual)
    const index = src.indexOf(actual)
    src.detachEditor(actual)
    try {
      // If the target already holds a same-id editor (e.g. a split clone),
      // openEditor migrates state into it and disposes this instance for us.
      dst.openEditor(actual, { sticky })
    } catch (err) {
      // Same ownership guarantee as EditorGroupsService.moveEditor: restore the
      // source before rethrowing so the input is never left ownerless — unless
      // the target adopted it before a listener threw.
      try {
        if (!dst.contains(actual)) src.openEditor(actual, { index, sticky })
      } catch (restoreErr) {
        this._logger.error(
          `part ${this.id}: moveEditor rollback failed id=${actual.id} source=${src.id}: ${String(restoreErr)}`,
        )
      }
      throw err
    }
    this._logger.info(`part ${this.id}: moveEditor id=${actual.id} from=${src.id} to=${dst.id}`)
  }

  copyEditor(editor: EditorInput, target: IEditorGroup, options?: { sticky?: boolean }): void {
    // VSCode parity (issue #99035): a plain copy does NOT travel the sticky
    // flag — split/drag-drop paths that mean to preserve it pass
    // `options.sticky` explicitly (editorGroupView.ts copyForSplit precedent).
    const dst = this._resolve(target)
    if (!dst) return
    dst.openEditor(editor, { sticky: options?.sticky ?? false })
    this._logger.info(`part ${this.id}: copyEditor id=${editor.id} to=${dst.id}`)
  }

  setGroupOrientation(orientation: GroupOrientation): void {
    this._orientation = orientation
    this._logger.debug(`part ${this.id}: setGroupOrientation orientation=${orientation}`)
  }

  arrangeGroups(_arrangement: GroupsArrangement, _group?: IEditorGroup): void {
    // No-op for the simplified renderer; the grid layout reflows automatically.
  }

  // Helpers ------------------------------------------------------------------

  private _createGroup(): EditorGroup {
    const group = new EditorGroup(this._register(new EditorGroupModel()), this)
    this._groups.push(group)
    this._mru.push(group)
    this._watchGroup(group)
    return group
  }

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
        // A group that stays empty cannot stay locked: there is nothing left to
        // protect, and `activeGroupForOpen` would route every open away from it
        // into a brand-new group. Deferred one microtask — like the removal
        // above — because "empty" is only meaningful once the current operation
        // finished: a toggle-preview or resolver upgrade detaches and reopens in
        // place within the same tick.
        if (group.count === 0 && group.isLocked) {
          queueMicrotask(() => {
            if (group.count === 0 && this._groups.includes(group) && group.isLocked) {
              group.lock(false)
              this._logger.debug(`part ${this.id}: unlocked empty group id=${group.id}`)
            }
          })
        }
      }),
    )
    this._groupWatchers.set(group.id, d)
  }

  private _resolve(group: IEditorGroup | number): EditorGroup | undefined {
    if (typeof group === 'number') return this._groups.find((g) => g.id === group)
    return this._groups.includes(group as EditorGroup) ? (group as EditorGroup) : undefined
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
          // Diff snapshots carry both sides' full text; routing them through
          // the budgeted serializer keeps this write off the megabyte scale.
          data:
            e instanceof DiffEditorInput ? e.serializeForPersistence() : (e.serialize?.() ?? null),
        })),
        activeIndex: activeIdx >= 0 ? activeIdx : 0,
        ...(group.stickyCount > 0 ? { sticky: group.stickyCount - 1 } : {}),
        ...(group.isLocked ? { locked: true } : {}),
        ...(Object.keys(viewStates).length > 0 && { viewStates }),
      }
    }) as ISerializedGrid<ISerializedEditorGroupData>
    const activeId = this.activeGroup.id
    const leafOrder: EditorGroup[] = []
    const walk = (node: GridNode<IEditorGroup>): void => {
      if (node.kind === 'leaf') {
        leafOrder.push(node.view as EditorGroup)
        return
      }
      for (const child of node.children) walk(child)
    }
    walk(this._grid.root)
    const activeGroupIndex = leafOrder.indexOf(this.activeGroup as EditorGroup)
    return {
      grid,
      activeGroupId: activeId,
      ...(activeGroupIndex >= 0 ? { activeGroupIndex } : {}),
    }
  }

  /**
   * Replace this part's grid + groups with the contents of `state`. Existing
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
        leafGroups.push(this._createGroup())
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
    if (
      state.activeGroupIndex !== undefined &&
      state.activeGroupIndex >= 0 &&
      state.activeGroupIndex < leafGroups.length
    ) {
      restoredActive = leafGroups[state.activeGroupIndex]
    }
    visitOrder.forEach((leaf, index) => {
      const target = leafGroups[index]!
      if (index > 0) this._onDidAddGroup.fire(target)
      const hydrated: EditorInput[] = []
      let restoredSticky = leaf.data.sticky
      for (const e of leaf.data.editors) {
        const input = EditorRegistry.deserialize(e.typeId, e.data, accessor)
        if (input) {
          hydrated.push(input)
        } else if (restoredSticky !== undefined && hydrated.length <= restoredSticky) {
          // A skipped entry inside the sticky region shifts the boundary.
          // Compare against `hydrated.length` (survivors), not the serialized
          // index — consecutive skips each collapse the region by one, which
          // VSCode's own `index <= data.sticky` check gets wrong.
          restoredSticky--
        }
      }
      hydrated.forEach((input, i) =>
        target.openEditor(input, {
          activate: false,
          sticky: restoredSticky !== undefined && i <= restoredSticky,
        }),
      )
      const activeIdx = Math.min(leaf.data.activeIndex, hydrated.length - 1)
      if (activeIdx >= 0 && hydrated[activeIdx]) target.setActive(hydrated[activeIdx]!)
      // Apply the exact locked state (the reused seed group may carry a stale
      // lock). A leaf that hydrated to zero editors never comes back locked — it
      // would route every later open into a brand-new group. (An empty leaf is
      // legitimate: a layout may hold empty groups, and unknown typeIds are
      // skipped.)
      if (leaf.data.locked === true && target.count === 0) {
        this._logger.debug(`part ${this.id}: restore dropping lock on empty group id=${target.id}`)
      }
      target.lock(leaf.data.locked === true && target.count > 0)
      if (leaf.data.viewStates) EditorViewStateCache.restoreGroup(target.id, leaf.data.viewStates)
      if (restoredActive === undefined && target.id === state.activeGroupId) restoredActive = target
    })

    // 6. Restore the active group (fall back to the first).
    const nextActive = restoredActive ?? this._groups[0]!
    this._activeGroup.set(nextActive, undefined)
    this._bumpMru(nextActive)
    this._onDidActiveGroupChange.fire(nextActive)
    this._logger.info(
      `part ${this.id}: restoreEditorGroups groups=${this._groups.length} active=${nextActive.id}`,
    )
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
    this._bumpMru(seed)
    this._onDidActiveGroupChange.fire(seed)
  }

  private _bumpMru(group: EditorGroup): void {
    const idx = this._mru.indexOf(group)
    if (idx !== -1) this._mru.splice(idx, 1)
    this._mru.unshift(group)
  }

  override dispose(): void {
    for (const d of this._groupWatchers.values()) d.dispose()
    this._groupWatchers.clear()
    for (const g of this._groups) g.model.dispose()
    this._groups.length = 0
    this._mru.length = 0
    super.dispose()
  }
}
