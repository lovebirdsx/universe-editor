/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILayoutService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '@universe-editor/platform'
import type { ILayoutService, IPartVisibilityChangeEvent } from '@universe-editor/platform'
import { PartId } from '@universe-editor/platform'

export class LayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined

  private readonly _visible = new Map<PartId, boolean>([
    [PartId.ActivityBar, true],
    [PartId.SideBar, true],
    [PartId.EditorArea, true],
    [PartId.Panel, true],
    [PartId.StatusBar, true],
  ])

  private readonly _emitter = new Emitter<IPartVisibilityChangeEvent>()
  readonly onDidChangePartVisibility = this._emitter.event

  getVisible(part: PartId): boolean {
    return this._visible.get(part) ?? true
  }

  setVisible(part: PartId, visible: boolean): void {
    if (this._visible.get(part) === visible) return
    this._visible.set(part, visible)
    this._emitter.fire({ part, visible })
  }

  toggleVisible(part: PartId): void {
    this.setVisible(part, !this.getVisible(part))
  }
}
