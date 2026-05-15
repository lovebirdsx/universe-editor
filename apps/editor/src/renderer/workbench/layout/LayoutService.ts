/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ILayoutService implementation for the renderer process.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { ILayoutService } from '@universe-editor/platform'
import { PartId } from '@universe-editor/platform'

const INITIAL_VISIBLE: Readonly<Record<PartId, boolean>> = {
  [PartId.ActivityBar]: true,
  [PartId.SideBar]: true,
  [PartId.EditorArea]: true,
  [PartId.Panel]: true,
  [PartId.StatusBar]: true,
}

export class LayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined

  readonly visible = observableValue<Readonly<Record<PartId, boolean>>>(
    'LayoutService.visible',
    INITIAL_VISIBLE,
  )

  getVisible(part: PartId): boolean {
    return this.visible.get()[part]
  }

  setVisible(part: PartId, visible: boolean): void {
    if (this.visible.get()[part] === visible) return
    this.visible.set({ ...this.visible.get(), [part]: visible }, undefined)
  }

  toggleVisible(part: PartId): void {
    this.setVisible(part, !this.getVisible(part))
  }
}
