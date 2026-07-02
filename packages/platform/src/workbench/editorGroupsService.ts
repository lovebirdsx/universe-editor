/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IEditorGroupsService — the multi-group editor container.
 *
 *  Inspired by VSCode's `vs/workbench/services/editor/common/editorGroupsService.ts`.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
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

/**
 * An IEditorGroup is the public-facing facade of one EditorGroupModel inside
 * an IEditorGroupsService. It exposes everything in IEditorGroupModel plus
 * grid-level placement information.
 */
export interface IEditorGroup extends IEditorGroupModel {
  readonly isActive: boolean
  /** Position in `groups` array in `GridAppearance` order. */
  readonly index: number
  focus(): void
  openEditor(editor: EditorInput, options?: IOpenEditorOptions): void
}

export interface IEditorGroupsService {
  readonly _serviceBrand: undefined

  readonly activeGroup: IEditorGroup
  /**
   * The group a freshly-opened editor should land in. Equals `activeGroup`
   * unless it is locked, in which case the first unlocked group is returned
   * (a new group is created + activated if every group is locked). Callers
   * that open a *new* resource should prefer this over `activeGroup`; revealing
   * an already-open editor should keep using `activeGroup`.
   */
  readonly activeGroupForOpen: IEditorGroup
  readonly groups: readonly IEditorGroup[]
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
  moveGroup(group: IEditorGroup, location: IEditorGroup, direction: GroupDirection): IEditorGroup
  moveEditor(editor: EditorInput, target: IEditorGroup): void
  copyEditor(editor: EditorInput, target: IEditorGroup): void
  setGroupOrientation(orientation: GroupOrientation): void
  arrangeGroups(arrangement: GroupsArrangement, group?: IEditorGroup): void
}

export const IEditorGroupsService = createDecorator<IEditorGroupsService>('editorGroupsService')
