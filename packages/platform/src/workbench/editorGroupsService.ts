/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IEditorGroupsService — the multi-group editor container.
 *
 *  Inspired by VSCode's `vs/workbench/services/editor/common/editorGroupsService.ts`.
 *
 *  The service aggregates one or more editor *parts* (one per workbench window:
 *  the main window plus any auxiliary editor windows). Layout operations are
 *  scoped to the part that owns the target group, while enumeration
 *  (`groups` / `getGroups` / `count` / `getGroup`) deliberately spans every
 *  part so Save All, dirty checks, extension enumeration and restore cover
 *  auxiliary windows too.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { Grid, GridAxis, IGridView } from '../base/grid.js'
import { createDecorator } from '../di/instantiation.js'
import type { EditorInput } from './editorService.js'
import type { IEditorGroupModel, IOpenEditorOptions } from './editorGroupModel.js'

export const enum GroupDirection {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
}

export const enum GroupOrientation {
  Horizontal = 0,
  Vertical = 1,
}

export const enum GroupsOrder {
  CreationTime = 0,
  MostRecentlyActive = 1,
  GridAppearance = 2,
}

export const enum GroupLocation {
  First = 0,
  Last = 1,
  Next = 2,
  Previous = 3,
}

export const enum GroupsArrangement {
  Even = 0,
  Maximize = 1,
  Expand = 2,
}

export interface IFindGroupScope {
  direction?: GroupDirection
  location?: GroupLocation
}

export interface ICreateEditorPartOptions {
  /**
   * Activate the new part immediately (default: true). Window services creating
   * a background window pass `false`.
   */
  readonly activate?: boolean
}

export interface IRemoveEditorPartOptions {
  /**
   * Remove the part even when it still holds editors (default: false). This
   * closes/disposes those editors, so callers that care about unsaved state
   * must migrate them first.
   */
  readonly force?: boolean
}

/**
 * An IEditorGroup is the public-facing facade of one EditorGroupModel inside
 * an IEditorGroupsService. It exposes everything in IEditorGroupModel plus
 * grid-level placement information.
 */
export interface IEditorGroup extends IEditorGroupModel, IGridView {
  /** The part (window) this group belongs to. */
  readonly part: IEditorPart
  /** Whether this group is the active group of the currently active part. */
  readonly isActive: boolean
  /** Position in the owning part's `groups` array (creation order). */
  readonly index: number
  focus(): void
  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void
  /**
   * 标记即将发生的激活是否要求保留键盘焦点。窗口获得原生焦点属于此类：
   * 把窗口带到前台不应把焦点从侧栏抢进 Monaco。传 false 清除旧意图。
   */
  preserveFocusOnActivation?(preserve?: boolean): void
}

/**
 * One window's editor layout: its own grid, groups, active group and MRU.
 *
 * Group ids are globally unique; a group never migrates between parts. Layout
 * operations (`findGroup`, `resizeGroup`, `addGroup`, ...) are part-scoped.
 */
export interface IEditorPart {
  readonly id: number
  readonly isMain: boolean
  /** Whether this is the workbench's active (focused) part. */
  readonly isActive: boolean
  /** Whether every group in this part is empty. */
  readonly isEmpty: boolean
  readonly grid: Grid<IEditorGroup>
  readonly groups: readonly IEditorGroup[]
  readonly activeGroup: IEditorGroup
  /**
   * The group a freshly-opened editor should land in within this part. Equals
   * `activeGroup` unless it is locked, in which case the first unlocked group
   * is returned (a new group is created + activated if every group is locked).
   */
  readonly activeGroupForOpen: IEditorGroup
  readonly count: number
  readonly orientation: GroupOrientation

  readonly onDidActiveGroupChange: Event<IEditorGroup>
  readonly onDidAddGroup: Event<IEditorGroup>
  readonly onDidRemoveGroup: Event<IEditorGroup>
  readonly onDidMoveGroup: Event<IEditorGroup>

  getGroup(id: number): IEditorGroup | undefined
  getGroups(order?: GroupsOrder): readonly IEditorGroup[]
  findGroup(scope: IFindGroupScope, source?: IEditorGroup, wrap?: boolean): IEditorGroup | undefined

  activateGroup(group: IEditorGroup | number): IEditorGroup
  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup
  removeGroup(group: IEditorGroup | number): void
  /**
   * Grow (`deltaPx` > 0) or shrink the group along `axis` by that many pixels,
   * taking the space from an adjacent sibling group in this part.
   *
   * Returns whether this part's editor grid owns a split along that axis.
   */
  resizeGroup(group: IEditorGroup, axis: GridAxis, deltaPx: number): boolean
  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup
  /**
   * Move `editor` into `target`. `source` disambiguates the source group when
   * the same input identity is open in several groups (copies, split clones);
   * without it the first group containing a matching input is used.
   */
  moveEditor(editor: EditorInput, target: IEditorGroup, source?: IEditorGroup): void
  /**
   * Copy `editor` into `target`. The copy is NOT sticky by default (VSCode
   * issue #99035); split/drag-drop callers that preserve the sticky state
   * pass `options.sticky` explicitly.
   *
   * The caller owns the input instance passed in: copying a shared instance
   * would let either group dispose it. Split/window copy paths must clone it
   * first (`cloneEditorInputForSplit`).
   */
  copyEditor(editor: EditorInput, target: IEditorGroup, options?: { sticky?: boolean }): void
  setGroupOrientation(orientation: GroupOrientation): void
  arrangeGroups(arrangement: GroupsArrangement, group?: IEditorGroup): void
}

export interface IActivatePartOptions {
  /** 激活 part 及其活动组，但不把键盘焦点移进编辑器（窗口激活的默认语义）。 */
  readonly preserveFocus?: boolean
}

export interface IEditorGroupsService {
  readonly _serviceBrand: undefined

  /** The main window's part. Always present, never removable. */
  readonly mainPart: IEditorPart
  /** The focused part. */
  readonly activePart: IEditorPart
  /** All parts in creation order; `parts[0] === mainPart`. */
  readonly parts: readonly IEditorPart[]
  /**
   * Main part's grid. Kept for compatibility with single-grid consumers;
   * multi-window code must render `part.grid` for the part it owns.
   */
  readonly grid: Grid<IEditorGroup>
  readonly orientation: GroupOrientation

  /**
   * Global active group (the active group of `activePart`). Always points at a
   * group in the focused window.
   */
  readonly activeGroup: IEditorGroup
  /**
   * The active part's lock-aware open target. A new resource opened through
   * `IEditorService` lands in the focused window.
   */
  readonly activeGroupForOpen: IEditorGroup
  /**
   * Every group across every part, in creation order. Deliberately global:
   * Save All, dirty checks, extension enumeration and close paths must see
   * auxiliary-window editors too.
   */
  readonly groups: readonly IEditorGroup[]
  readonly count: number

  readonly onDidActiveGroupChange: Event<IEditorGroup>
  readonly onDidAddGroup: Event<IEditorGroup>
  readonly onDidRemoveGroup: Event<IEditorGroup>
  readonly onDidMoveGroup: Event<IEditorGroup>

  /** Fires when window focus moves to another part. */
  readonly onDidActivePartChange: Event<IEditorPart>
  readonly onDidAddPart: Event<IEditorPart>
  readonly onDidRemovePart: Event<IEditorPart>

  getGroup(id: number): IEditorGroup | undefined
  getGroups(order?: GroupsOrder): readonly IEditorGroup[]
  /**
   * Spatial / sequential navigation is scoped to the part owning `source`.
   * `First`/`Last`/`Next`/`Previous` therefore mean "within that window".
   */
  findGroup(scope: IFindGroupScope, source?: IEditorGroup, wrap?: boolean): IEditorGroup | undefined

  activateGroup(group: IEditorGroup | number): IEditorGroup
  activatePart(part: IEditorPart | number, options?: IActivatePartOptions): IEditorPart
  addGroup(location: IEditorGroup | number, direction: GroupDirection): IEditorGroup
  removeGroup(group: IEditorGroup | number): void
  /**
   * Grow (`deltaPx` > 0) or shrink the group along `axis` by that many pixels,
   * taking the space from a sibling group in the owner part.
   *
   * Returns whether the owner part's grid owns a split along that axis: `false`
   * means the group has no neighbour to trade space with, so a caller driving
   * this from the workbench chrome can fall back to resizing that instead.
   */
  resizeGroup(group: IEditorGroup, axis: GridAxis, deltaPx: number): boolean
  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup
  moveEditor(editor: EditorInput, target: IEditorGroup, source?: IEditorGroup): void
  copyEditor(editor: EditorInput, target: IEditorGroup, options?: { sticky?: boolean }): void
  setGroupOrientation(orientation: GroupOrientation): void
  arrangeGroups(arrangement: GroupsArrangement, group?: IEditorGroup): void

  getPart(id: number): IEditorPart | undefined
  /**
   * Create a DOM-free auxiliary editor part (one window's layout). The part
   * starts with one empty group. Window services own the actual BrowserWindow
   * and React portal; this only creates the model.
   */
  createAuxiliaryPart(options?: ICreateEditorPartOptions): IEditorPart
  /**
   * Remove an auxiliary part. The main part cannot be removed. Unless
   * `force` is set, the part must be empty — migrate its editors first so a
   * failed window handoff cannot drop unsaved content.
   */
  removePart(part: IEditorPart | number, options?: IRemoveEditorPartOptions): boolean
}

export const IEditorGroupsService = createDecorator<IEditorGroupsService>('editorGroupsService')
