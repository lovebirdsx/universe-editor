/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILayoutService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type {
  ILayoutService,
  IPartVisibilityChangeEvent,
  LayoutState,
  IDisposable,
} from '@universe-editor/platform'
import { PartId } from '@universe-editor/platform'

const INITIAL_STATE: LayoutState = Object.freeze({
  visible: Object.freeze({
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.EditorArea]: true,
    [PartId.Panel]: true,
    [PartId.StatusBar]: true,
  }),
})

export class LayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined

  private _state: LayoutState = INITIAL_STATE

  private readonly _onChange = new Emitter<void>()
  private readonly _onDidChangePartVisibility = new Emitter<IPartVisibilityChangeEvent>()
  readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event

  getSnapshot(): LayoutState {
    return this._state
  }

  subscribe(listener: () => void): IDisposable {
    return this._onChange.event(listener)
  }

  getVisible(part: PartId): boolean {
    return this._state.visible[part] ?? true
  }

  setVisible(part: PartId, visible: boolean): void {
    if (this._state.visible[part] === visible) return
    this._commit(
      Object.freeze({
        visible: Object.freeze({ ...this._state.visible, [part]: visible }),
      }),
    )
    this._onDidChangePartVisibility.fire({ part, visible })
  }

  toggleVisible(part: PartId): void {
    this.setVisible(part, !this.getVisible(part))
  }

  private _commit(next: LayoutState): void {
    if (next === this._state) return
    this._state = next
    this._onChange.fire()
  }
}
