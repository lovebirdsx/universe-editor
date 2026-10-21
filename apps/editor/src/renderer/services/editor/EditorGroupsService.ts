/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupsService — global DI entry and cross-part aggregation.
 *
 *  Owns the collection of editor parts (one per workbench window). Each part
 *  (`EditorPart`) keeps the single-grid algorithm, its local groups/active
 *  group/MRU and serialization. This service keeps the global group enumeration
 *  (Save All, dirty checks, extension enumeration), the global MRU and the
 *  active-part/active-group events.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  EditorInput,
  Emitter,
  Event,
  GroupDirection,
  GroupOrientation,
  GroupsArrangement,
  GroupsOrder,
  NullLogger,
  type Grid,
  type GridAxis,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorPart,
  type IFindGroupScope,
  type ILogger,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { EditorPart } from './EditorPart.js'
import type { ISerializedEditorGroupsState } from './editorGroupsPersistence.js'

export { EditorGroup } from './EditorGroup.js'
export { EditorPart } from './EditorPart.js'
export type {
  ISerializedEditorGroupData,
  ISerializedEditorGroupsState,
  ISerializedEditorInputData,
} from './editorGroupsPersistence.js'

export class EditorGroupsService extends Disposable implements IEditorGroupsService {
  declare readonly _serviceBrand: undefined

  private readonly _mainPart: EditorPart
  private readonly _parts: EditorPart[] = []
  private _activePart: EditorPart
  private readonly _globalMru: IEditorGroup[] = []
  private readonly _partStores = new Map<EditorPart, DisposableStore>()

  private readonly _onDidActiveGroupChange = this._register(new Emitter<IEditorGroup>())
  readonly onDidActiveGroupChange: Event<IEditorGroup> = this._onDidActiveGroupChange.event

  private readonly _onDidAddGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidAddGroup: Event<IEditorGroup> = this._onDidAddGroup.event

  private readonly _onDidRemoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidRemoveGroup: Event<IEditorGroup> = this._onDidRemoveGroup.event

  private readonly _onDidMoveGroup = this._register(new Emitter<IEditorGroup>())
  readonly onDidMoveGroup: Event<IEditorGroup> = this._onDidMoveGroup.event

  private readonly _onDidActivePartChange = this._register(new Emitter<IEditorPart>())
  readonly onDidActivePartChange: Event<IEditorPart> = this._onDidActivePartChange.event

  private readonly _onDidAddPart = this._register(new Emitter<IEditorPart>())
  readonly onDidAddPart: Event<IEditorPart> = this._onDidAddPart.event

  private readonly _onDidRemovePart = this._register(new Emitter<IEditorPart>())
  readonly onDidRemovePart: Event<IEditorPart> = this._onDidRemovePart.event

  private readonly _host = {
    activatePart: (part: IEditorPart): boolean => this._setActivePart(part as EditorPart, false),
    isPartActive: (part: IEditorPart): boolean => this._activePart === part,
  }

  constructor(private readonly _logger: ILogger = new NullLogger()) {
    super()
    // The parts own emitters/group watchers; registering them (and the per-part
    // subscription store below) under this service keeps the whole tree rooted
    // at the singleton DI service, so the renderer leak gate can resolve it.
    this._mainPart = this._register(
      new EditorPart(this._host, { isMain: true, logger: this._logger }),
    )
    this._parts.push(this._mainPart)
    this._activePart = this._mainPart
    this._trackPart(this._mainPart)
    this._globalMru.push(this._mainPart.activeGroup)
  }

  get mainPart(): EditorPart {
    return this._mainPart
  }

  get activePart(): EditorPart {
    return this._activePart
  }

  get parts(): readonly EditorPart[] {
    return this._parts
  }

  /** Compatibility handle: the main part's grid. Multi-window code uses `part.grid`. */
  get grid(): Grid<IEditorGroup> {
    return this._mainPart.grid
  }

  get orientation(): GroupOrientation {
    return this._mainPart.orientation
  }

  get activeGroup(): IEditorGroup {
    return this._activePart.activeGroup
  }

  get activeGroupForOpen(): IEditorGroup {
    return this._activePart.activeGroupForOpen
  }

  get groups(): readonly IEditorGroup[] {
    const all: IEditorGroup[] = []
    for (const part of this._parts) all.push(...part.groups)
    // Group ids are globally monotonic, so sorting restores global creation
    // order even when a newer group was added to an older part.
    return all.sort((a, b) => a.id - b.id)
  }

  get count(): number {
    let count = 0
    for (const part of this._parts) count += part.count
    return count
  }

  getGroup(id: number): IEditorGroup | undefined {
    for (const part of this._parts) {
      const group = part.getGroup(id)
      if (group) return group
    }
    return undefined
  }

  getGroups(order: GroupsOrder = GroupsOrder.CreationTime): readonly IEditorGroup[] {
    if (order === GroupsOrder.MostRecentlyActive) {
      const present = new Set(this.groups)
      const result = this._globalMru.filter((g) => present.has(g))
      const seen = new Set(result)
      for (const g of this.groups) {
        if (!seen.has(g)) {
          seen.add(g)
          result.push(g)
        }
      }
      return result
    }
    if (order === GroupsOrder.GridAppearance) {
      return this._parts.flatMap((part) => part.getGroups(GroupsOrder.GridAppearance))
    }
    return this.groups
  }

  findGroup(
    scope: IFindGroupScope,
    source: IEditorGroup = this.activeGroup,
    wrap = false,
  ): IEditorGroup | undefined {
    const owner = this._partForGroup(source) ?? this._activePart
    return owner.findGroup(scope, source, wrap)
  }

  activateGroup(group: IEditorGroup | number): IEditorGroup {
    const target = this._resolveGroup(group)
    if (!target) return this.activeGroup
    return (target.part as EditorPart).activateGroup(target)
  }

  activatePart(part: IEditorPart | number, options?: { preserveFocus?: boolean }): IEditorPart {
    const target = this._resolvePart(part)
    if (!target) return this._activePart
    this._setActivePart(target, true, options?.preserveFocus === true)
    return target
  }

  getPart(id: number): IEditorPart | undefined {
    return this._parts.find((part) => part.id === id)
  }

  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup {
    const locationGroup =
      typeof location === 'number' ? this.getGroup(location) : this._resolveGroup(location)
    const owner = locationGroup ? (locationGroup.part as EditorPart) : this._activePart
    return owner.addGroup(location, direction)
  }

  removeGroup(group: IEditorGroup | number): void {
    const target = this._resolveGroup(group)
    if (!target) return
    ;(target.part as EditorPart).removeGroup(target)
  }

  resizeGroup(group: IEditorGroup, axis: GridAxis, deltaPx: number): boolean {
    const target = this._resolveGroup(group)
    if (!target) return false
    return (target.part as EditorPart).resizeGroup(target, axis, deltaPx)
  }

  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup {
    const src = this._resolveGroup(group)
    const dst = this._resolveGroup(location)
    if (!src) return group
    if (!dst) return src
    if (src.part !== dst.part) {
      // Groups own their part's grid; re-homing a group across windows is a
      // separate migration flow (window service), not a layout operation.
      this._logger.warn(
        `moveGroup: refusing cross-part move id=${src.id} from=${src.part.id} to=${dst.part.id}`,
      )
      return src
    }
    return (src.part as EditorPart).moveGroup(src, dst, direction)
  }

  moveEditor(editor: EditorInput, target: IEditorGroup, source?: IEditorGroup): void {
    const dst = this._resolveGroup(target)
    if (!dst) return
    const src = source ? this._resolveGroup(source) : this._findGroupContaining(editor)
    if (!src) return
    if (src === dst) return
    const actual = src.findEditor(editor)
    if (!actual) return
    const sticky = src.isSticky(actual)
    const index = src.indexOf(actual)
    src.detachEditor(actual)
    try {
      // If the target already holds a same-id editor (e.g. a split clone),
      // `openEditor` migrates its state into that target instance and disposes
      // this one. Cross-part moves therefore keep model/dirty state alive.
      dst.openEditor(actual, { sticky })
    } catch (err) {
      // The detach already happened, so a throwing migration hook would leave
      // the input owned by nobody (and dirty state unreachable). Put it back in
      // the source before surfacing the failure — unless the target did adopt
      // it before a listener threw.
      try {
        if (!dst.contains(actual)) src.openEditor(actual, { index, sticky })
      } catch (restoreErr) {
        this._logger.error(
          `moveEditor rollback failed id=${actual.id} source=${src.id}: ${String(restoreErr)}`,
        )
      }
      throw err
    }
    this._logger.info(
      `moveEditor id=${actual.id} from=part:${src.part.id}/group:${src.id} to=part:${dst.part.id}/group:${dst.id}`,
    )
  }

  copyEditor(editor: EditorInput, target: IEditorGroup, options?: { sticky?: boolean }): void {
    // VSCode parity (issue #99035): a plain copy does NOT travel the sticky
    // flag — split/drag-drop paths that mean to preserve it pass
    // `options.sticky` explicitly (editorGroupView.ts copyForSplit precedent).
    const dst = this._resolveGroup(target)
    if (!dst) return
    dst.openEditor(editor, { sticky: options?.sticky ?? false })
    this._logger.info(`copyEditor id=${editor.id} to=part:${dst.part.id}/group:${dst.id}`)
  }

  setGroupOrientation(orientation: GroupOrientation): void {
    for (const part of this._parts) part.setGroupOrientation(orientation)
    this._logger.debug(`setGroupOrientation orientation=${orientation}`)
  }

  arrangeGroups(arrangement: GroupsArrangement, group?: IEditorGroup): void {
    // No-op for the simplified renderer; the grid layout reflows automatically.
    for (const part of this._parts) part.arrangeGroups(arrangement, group)
  }

  createAuxiliaryPart(options?: { activate?: boolean }): EditorPart {
    const part = this._register(new EditorPart(this._host, { isMain: false, logger: this._logger }))
    this._parts.push(part)
    this._trackPart(part)
    this._globalMru.push(part.activeGroup)
    this._onDidAddPart.fire(part)
    // The initial group is created by the part's constructor, which cannot
    // fire before listeners are attached; announce it now so group trackers
    // (Outline, focus restore, dirty checks) see the new part's group.
    this._onDidAddGroup.fire(part.activeGroup)
    if (options?.activate !== false) this._setActivePart(part, true)
    this._logger.info(`createAuxiliaryPart id=${part.id} activate=${options?.activate !== false}`)
    return part
  }

  removePart(part: IEditorPart | number, options?: { force?: boolean }): boolean {
    const target = this._resolvePart(part)
    if (!target || target.isMain) return false
    if (!options?.force && !target.isEmpty) {
      this._logger.warn(`removePart: refusing non-empty part id=${target.id}`)
      return false
    }
    this._destroyPart(target, options?.force === true)
    return true
  }

  // Persistence --------------------------------------------------------------

  /** Serializes the main part; per-part state is available through `part.toJSON()`. */
  toJSON(): ISerializedEditorGroupsState {
    return this._mainPart.toJSON()
  }

  /**
   * Restore the main part from a workspace snapshot. Auxiliary parts belong to
   * the window layout (coordinated separately) and are torn down here.
   */
  restore(state: ISerializedEditorGroupsState, accessor?: ServicesAccessor): void {
    this._removeAuxiliaryParts()
    if (this._activePart !== this._mainPart) this._setActivePart(this._mainPart, true)
    this._mainPart.restore(state, accessor)
    this._rebuildGlobalMru()
  }

  /**
   * Tear down all parts to the main part's single empty seed group. Used when
   * the active workspace changes and there's no persisted state for the new
   * workspace.
   */
  clearAll(): void {
    this._removeAuxiliaryParts()
    if (this._activePart !== this._mainPart) this._setActivePart(this._mainPart, true)
    this._mainPart.clearAll()
    this._rebuildGlobalMru()
  }

  // Internals ----------------------------------------------------------------

  private _trackPart(part: EditorPart): void {
    // Registered under the service (not a bare store): on page unload the
    // service is a singleton root, while an unparented store reads as a leak.
    const store = this._register(new DisposableStore())
    store.add(
      part.onDidAddGroup((group) => {
        this._globalMru.push(group)
        this._onDidAddGroup.fire(group)
      }),
    )
    store.add(
      part.onDidRemoveGroup((group) => {
        const idx = this._globalMru.indexOf(group)
        if (idx !== -1) this._globalMru.splice(idx, 1)
        this._onDidRemoveGroup.fire(group)
      }),
    )
    store.add(part.onDidMoveGroup((group) => this._onDidMoveGroup.fire(group)))
    store.add(
      part.onDidActiveGroupChange((group) => {
        // A part only announces an active-group change after focusing itself,
        // so this is a global active-group change. Still guard: restore/clear
        // may drive a background part directly.
        if (this._activePart !== part) return
        this._bumpGlobalMru(group)
        this._onDidActiveGroupChange.fire(group)
      }),
    )
    this._partStores.set(part, store)
  }

  private _setActivePart(
    part: EditorPart,
    fireGroupChange: boolean,
    preserveFocus = false,
  ): boolean {
    if (this._activePart === part) return false
    this._activePart = part
    this._onDidActivePartChange.fire(part)
    if (fireGroupChange) {
      const group = part.activeGroup
      // 必须先标记再广播：EditorGroupView / FileEditor 在同一任务里读取该意图。
      // 默认 false 也要写入，清掉上一次窗口激活遗留的保留焦点标志。
      group.preserveFocusOnActivation?.(preserveFocus)
      this._bumpGlobalMru(group)
      this._onDidActiveGroupChange.fire(group)
    }
    this._logger.debug(`activatePart id=${part.id}${preserveFocus ? ' preserveFocus' : ''}`)
    return true
  }

  private _destroyPart(part: EditorPart, force: boolean): void {
    if (this._activePart === part) this._setActivePart(this._mainPart, true)
    const index = this._parts.indexOf(part)
    if (index === -1) return
    this._parts.splice(index, 1)
    const store = this._partStores.get(part)
    if (store) {
      store.dispose()
      this._partStores.delete(part)
    }
    const groups = [...part.groups]
    for (const group of groups) {
      const mruIdx = this._globalMru.indexOf(group)
      if (mruIdx !== -1) this._globalMru.splice(mruIdx, 1)
      this._onDidRemoveGroup.fire(group)
    }
    this._onDidRemovePart.fire(part)
    part.dispose()
    this._logger.info(`removePart id=${part.id} force=${force}`)
  }

  private _removeAuxiliaryParts(): void {
    for (let i = this._parts.length - 1; i >= 0; i--) {
      const part = this._parts[i]!
      if (!part.isMain) this._destroyPart(part, true)
    }
  }

  private _rebuildGlobalMru(): void {
    this._globalMru.length = 0
    for (const part of this._parts) {
      for (const group of part.getGroups(GroupsOrder.MostRecentlyActive)) {
        this._globalMru.push(group)
      }
    }
  }

  private _bumpGlobalMru(group: IEditorGroup): void {
    let idx = this._globalMru.indexOf(group)
    while (idx !== -1) {
      this._globalMru.splice(idx, 1)
      idx = this._globalMru.indexOf(group)
    }
    this._globalMru.unshift(group)
  }

  private _resolvePart(part: IEditorPart | number): EditorPart | undefined {
    if (typeof part === 'number') return this._parts.find((p) => p.id === part)
    return this._parts.includes(part as EditorPart) ? (part as EditorPart) : undefined
  }

  private _resolveGroup(group: IEditorGroup | number): IEditorGroup | undefined {
    if (typeof group === 'number') return this.getGroup(group)
    const part = this._partForGroup(group)
    return part ? part.getGroup(group.id) : undefined
  }

  private _partForGroup(group: IEditorGroup): EditorPart | undefined {
    const candidate = group.part as EditorPart | undefined
    if (candidate && this._parts.includes(candidate)) return candidate
    for (const part of this._parts) {
      if (part.getGroup(group.id) === group) return part
    }
    return undefined
  }

  private _findGroupContaining(editor: EditorInput): IEditorGroup | undefined {
    for (const part of this._parts) {
      for (const group of part.groups) {
        if (group.contains(editor)) return group
      }
    }
    return undefined
  }

  override dispose(): void {
    for (const store of this._partStores.values()) store.dispose()
    this._partStores.clear()
    for (const part of this._parts) part.dispose()
    this._parts.length = 0
    this._globalMru.length = 0
    super.dispose()
  }
}
