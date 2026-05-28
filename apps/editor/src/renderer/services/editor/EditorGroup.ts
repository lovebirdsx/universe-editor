/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroup — adapter that satisfies both IEditorGroup and IGridView for a
 *  single EditorGroupModel inside the grid. Kept separate from
 *  EditorGroupsService to break a circular dependency while still letting the
 *  group reach the active-group / activate APIs of its owning service via the
 *  IEditorGroupsService interface.
 *--------------------------------------------------------------------------------------------*/

import {
  Direction,
  EditorGroupModel,
  EditorInput,
  GroupDirection,
  IEditorGroup,
  IEditorGroupsService,
  IGridView,
  IOpenEditorOptions,
} from '@universe-editor/platform'

export class EditorGroup implements IEditorGroup, IGridView {
  readonly minimumWidth = 170
  readonly maximumWidth = Number.POSITIVE_INFINITY
  readonly minimumHeight = 70
  readonly maximumHeight = Number.POSITIVE_INFINITY

  constructor(
    readonly model: EditorGroupModel,
    private readonly _service: IEditorGroupsService,
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
  get previewEditor() {
    return this.model.previewEditor
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
  detachEditor(editor: EditorInput): boolean {
    return this.model.detachEditor(editor)
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
  pinEditor(editor: EditorInput): void {
    this.model.pinEditor(editor)
  }
  isPinned(editor: EditorInput): boolean {
    return this.model.isPinned(editor)
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

export function directionToGridDirection(d: GroupDirection): Direction {
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
