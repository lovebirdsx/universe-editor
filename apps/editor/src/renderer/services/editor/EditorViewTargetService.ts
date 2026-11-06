/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorViewTargetService — the editor surface information views describe.
 *
 *  It defaults to `IEditorGroupsService.openTargetPart`, i.e. the last-used
 *  editor surface. Focusing the main window's sidebar or Alt-Tabbing back to it
 *  changes `activePart` (the command target) but not this target, so an Outline
 *  in the main window keeps showing the auxiliary window's editor while the user
 *  interacts with it. Commands must keep using `activePart`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IEditorGroupsService,
  createDecorator,
  observableValue,
  transaction,
  type EditorInput,
  type IEditorGroup,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'

export interface IEditorViewTargetService {
  readonly _serviceBrand: undefined
  /** The editor group whose active editor information views should describe. */
  readonly targetGroup: IObservable<IEditorGroup>
  /** `targetGroup.activeEditor`, kept in sync with group/editor events. */
  readonly targetEditor: IObservable<EditorInput | undefined>
}

export const IEditorViewTargetService =
  createDecorator<IEditorViewTargetService>('editorViewTargetService')

export class EditorViewTargetService extends Disposable implements IEditorViewTargetService {
  declare readonly _serviceBrand: undefined

  private readonly _groups: IEditorGroupsService
  private readonly _targetGroup: ISettableObservable<IEditorGroup>
  private readonly _targetEditor: ISettableObservable<EditorInput | undefined>
  private readonly _partStore = this._register(new DisposableStore())
  private readonly _groupStore = this._register(new DisposableStore())
  private _boundGroup: IEditorGroup | undefined

  readonly targetGroup: IObservable<IEditorGroup>
  readonly targetEditor: IObservable<EditorInput | undefined>

  constructor(@IEditorGroupsService groups: IEditorGroupsService) {
    super()
    this._groups = groups
    const initial = groups.openTargetGroup
    this._targetGroup = observableValue('EditorViewTargetService.targetGroup', initial)
    this._targetEditor = observableValue(
      'EditorViewTargetService.targetEditor',
      initial.activeEditor,
    )
    this.targetGroup = this._targetGroup
    this.targetEditor = this._targetEditor
    this._bind(initial)
    this._register(groups.onDidActivateOpenTargetGroup((group) => this._setGroup(group)))
    // Silent open-target fallbacks (window/group removal) deliberately do not
    // fire onDidActivateOpenTargetGroup; re-read the live open target instead.
    this._register(groups.onDidRemovePart(() => this._syncFromGroups()))
    this._register(groups.onDidRemoveGroup(() => this._syncFromGroups()))
  }

  private _setGroup(group: IEditorGroup): void {
    if (this._boundGroup === group) {
      this._updateEditor()
      return
    }
    this._bind(group)
    transaction((tx) => {
      this._targetGroup.set(group, tx)
      this._targetEditor.set(group.activeEditor, tx)
    })
  }

  private _syncFromGroups(): void {
    this._setGroup(this._groups.openTargetGroup)
  }

  private _bind(group: IEditorGroup): void {
    this._partStore.clear()
    this._groupStore.clear()
    this._boundGroup = group
    this._partStore.add(group.part.onDidActiveGroupChange((next) => this._setGroup(next)))
    this._groupStore.add(group.onDidActiveEditorChange(() => this._updateEditor()))
    this._groupStore.add(group.onDidChangeModel(() => this._updateEditor()))
  }

  private _updateEditor(): void {
    const group = this._boundGroup
    if (!group) return
    this._targetEditor.set(group.activeEditor, undefined)
  }
}
