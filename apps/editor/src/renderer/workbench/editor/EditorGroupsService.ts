/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupsService — renderer-side implementation.
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
  IEditorGroup,
  IEditorGroupsService,
  IFindGroupScope,
  IGridView,
  IOpenEditorOptions,
  type ISerializedGrid,
  type ISerializedGridNode,
  Orientation,
  type ServicesAccessor,
  observableValue,
  transaction,
} from '@universe-editor/platform'

/**
 * Adapter that satisfies both IEditorGroup and IGridView for a single
 * EditorGroupModel inside the grid.
 */
class EditorGroup implements IEditorGroup, IGridView {
  readonly minimumWidth = 170
  readonly maximumWidth = Number.POSITIVE_INFINITY
  readonly minimumHeight = 70
  readonly maximumHeight = Number.POSITIVE_INFINITY

  constructor(
    readonly model: EditorGroupModel,
    private readonly _service: EditorGroupsService,
  ) {}

  get id(): number {
    return this.model.id
  }

  get viewId(): string {
    return String(this.model.id)
  }

  get isActive(): boolean {
    return this._service.activeGroup === this
  }

  get index(): number {
    return this._service.groups.indexOf(this)
  }

  focus(): void {
    this._service.activateGroup(this)
  }

  // Delegated IEditorGroupModel surface ---------------------------------------

  get editors() {
    return this.model.editors
  }
  get activeEditor() {
    return this.model.activeEditor
  }
  get count() {
    return this.model.count
  }
  get onDidChangeModel() {
    return this.model.onDidChangeModel
  }
  get onDidActiveEditorChange() {
    return this.model.onDidActiveEditorChange
  }

  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void {
    this.model.openEditor(editor, options)
  }
  closeEditor(editor: EditorInput): boolean {
    return this.model.closeEditor(editor)
  }
  closeAllEditors(): void {
    this.model.closeAllEditors()
  }
  moveEditor(editor: EditorInput, toIndex: number): void {
    this.model.moveEditor(editor, toIndex)
  }
  setActive(editor: EditorInput): void {
    this.model.setActive(editor)
  }
  getEditorByIndex(index: number) {
    return this.model.getEditorByIndex(index)
  }
  indexOf(editor: EditorInput): number {
    return this.model.indexOf(editor)
  }
  contains(editor: EditorInput): boolean {
    return this.model.contains(editor)
  }
  findEditor(editor: EditorInput): EditorInput | undefined {
    return this.model.findEditor(editor)
  }
  isFirst(editor: EditorInput): boolean {
    return this.model.isFirst(editor)
  }
  isLast(editor: EditorInput): boolean {
    return this.model.isLast(editor)
  }
}

function directionToGridDirection(d: GroupDirection): Direction {
  switch (d) {
    case GroupDirection.Up:
      return Direction.Up
    case GroupDirection.Down:
      return Direction.Down
    case GroupDirection.Left:
      return Direction.Left
    default:
      return Direction.Right
  }
}

export class EditorGroupsService extends Disposable implements IEditorGroupsService {
  declare readonly _serviceBrand: undefined

  private readonly _grid: Grid<EditorGroup>
  private readonly _groups: EditorGroup[] = []
  private readonly _mru: EditorGroup[] = []
  private _orientation: GroupOrientation = GroupOrientation.Horizontal

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

  constructor() {
    super()
    const initial = new EditorGroup(new EditorGroupModel(), this)
    this._groups.push(initial)
    this._mru.push(initial)
    this._grid = new Grid<EditorGroup>(initial, Orientation.Horizontal)
    this._activeGroup = observableValue<EditorGroup>('activeGroup', initial)
  }

  get activeGroup(): IEditorGroup {
    return this._activeGroup.get()
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
      // Simplified: treat direction as next/prev along the creation order.
      // (A richer implementation walks the grid tree spatially.)
      const delta =
        scope.direction === GroupDirection.Right || scope.direction === GroupDirection.Down ? 1 : -1
      const target = idx + delta
      if (target >= 0 && target < this._groups.length) return this._groups[target]
      return wrap ? this._groups[(target + this._groups.length) % this._groups.length] : undefined
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
    return target
  }

  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup {
    const target = this._resolve(location) ?? (this.activeGroup as EditorGroup)
    const newGroup = new EditorGroup(new EditorGroupModel(), this)
    this._grid.addView(newGroup, 200, target as EditorGroup, directionToGridDirection(direction))
    this._groups.push(newGroup)
    this._mru.push(newGroup)
    this._onDidAddGroup.fire(newGroup)
    return newGroup
  }

  removeGroup(group: IEditorGroup | number): void {
    if (this._groups.length <= 1) return // protect: keep at least one group
    const target = this._resolve(group)
    if (!target) return
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
  }

  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup {
    const src = group as EditorGroup
    const dst = location as EditorGroup
    if (src === dst) return src
    this._grid.moveView(src, dst, directionToGridDirection(direction))
    this._onDidMoveGroup.fire(src)
    return src
  }

  moveEditor(editor: EditorInput, target: IEditorGroup): void {
    const src = this._findGroupContaining(editor)
    if (!src) return
    if (src === target) return
    src.closeEditor(editor)
    ;(target as EditorGroup).openEditor(editor)
  }

  copyEditor(editor: EditorInput, target: IEditorGroup): void {
    ;(target as EditorGroup).openEditor(editor)
  }

  setGroupOrientation(orientation: GroupOrientation): void {
    this._orientation = orientation
  }

  arrangeGroups(_arrangement: GroupsArrangement, _group?: IEditorGroup): void {
    // No-op for the simplified renderer; the grid layout reflows automatically.
  }

  // Helpers ------------------------------------------------------------------

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
    const grid = this._grid.serialize((group) => ({
      editors: group.editors.map((e) => ({
        typeId: e.typeId,
        data: e.serialize?.() ?? null,
      })),
      activeIndex: group.activeEditor ? Math.max(0, group.editors.indexOf(group.activeEditor)) : 0,
    })) as ISerializedGrid<ISerializedEditorGroupData>
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
    //    first group so it can be reused as the seed leaf.
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

    // 2. Walk the serialized tree in depth-first order; the first leaf
    //    populates the seed group, subsequent leaves call addGroup() against
    //    the previous leaf's group with a direction derived from the parent
    //    branch's orientation.
    const visitOrder: { data: ISerializedEditorGroupData; direction?: Direction }[] = []
    collectLeavesInOrder(state.grid.root, undefined, visitOrder)

    let restoredActive: EditorGroup | undefined
    visitOrder.forEach((leaf, index) => {
      let target: EditorGroup
      if (index === 0) {
        target = seed
      } else {
        const dir = leaf.direction ?? Direction.Right
        const newGroup = new EditorGroup(new EditorGroupModel(), this)
        this._grid.addView(newGroup, 200, this._groups[index - 1]!, dir)
        this._groups.push(newGroup)
        this._mru.push(newGroup)
        this._onDidAddGroup.fire(newGroup)
        target = newGroup
      }
      const hydrated: EditorInput[] = []
      for (const e of leaf.data.editors) {
        const input = EditorRegistry.deserialize(e.typeId, e.data, accessor)
        if (input) hydrated.push(input)
      }
      hydrated.forEach((input) => target.openEditor(input, { activate: false }))
      const activeIdx = Math.min(leaf.data.activeIndex, hydrated.length - 1)
      if (activeIdx >= 0 && hydrated[activeIdx]) target.setActive(hydrated[activeIdx]!)
      if (target.id === state.activeGroupId) restoredActive = target
    })

    // 3. Restore the active group (fall back to the first).
    const nextActive = restoredActive ?? this._groups[0]!
    this._activeGroup.set(nextActive, undefined)
    this._onDidActiveGroupChange.fire(nextActive)
  }
}

// Persistence helpers --------------------------------------------------------

export interface ISerializedEditorInputData {
  readonly typeId: string
  readonly data: unknown
}

export interface ISerializedEditorGroupData {
  readonly editors: readonly ISerializedEditorInputData[]
  readonly activeIndex: number
}

export interface ISerializedEditorGroupsState {
  readonly grid: ISerializedGrid<ISerializedEditorGroupData>
  readonly activeGroupId: number
}

function collectLeavesInOrder(
  node: ISerializedGridNode<unknown>,
  parentOrientation: Orientation | undefined,
  out: { data: ISerializedEditorGroupData; direction?: Direction }[],
  childIndex = 0,
): void {
  if (node.type === 'leaf') {
    const data = node.data as ISerializedEditorGroupData
    if (out.length === 0 || childIndex === 0 || parentOrientation === undefined) {
      out.push({ data })
    } else {
      const dir = parentOrientation === Orientation.Horizontal ? Direction.Right : Direction.Down
      out.push({ data, direction: dir })
    }
    return
  }
  const orient = node.orientation ?? Orientation.Horizontal
  ;(node.children ?? []).forEach((child, i) => {
    collectLeavesInOrder(child, orient, out, i)
  })
}
