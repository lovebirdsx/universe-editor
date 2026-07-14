/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window zoom commands: zoom in / out / reset. These drive the whole window's
 *  zoom level (via IHostService → webContents.setZoomLevel), mirroring VSCode's
 *  View > Appearance > Zoom trio.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IHostService,
  MenuId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize2('command.category.view', 'View')

export class ZoomInAction extends Action2 {
  static readonly ID = 'workbench.action.zoomIn'
  constructor() {
    super({
      id: ZoomInAction.ID,
      title: localize2('action.zoomIn.title', 'Zoom In'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+=' },
      menu: { id: MenuId.MenubarViewMenu, group: '4_zoom', order: 1 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).zoomIn()
  }
}

export class ZoomOutAction extends Action2 {
  static readonly ID = 'workbench.action.zoomOut'
  constructor() {
    super({
      id: ZoomOutAction.ID,
      title: localize2('action.zoomOut.title', 'Zoom Out'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+-' },
      menu: { id: MenuId.MenubarViewMenu, group: '4_zoom', order: 2 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).zoomOut()
  }
}

export class ResetZoomAction extends Action2 {
  static readonly ID = 'workbench.action.zoomReset'
  constructor() {
    super({
      id: ResetZoomAction.ID,
      title: localize2('action.zoomReset.title', 'Reset Zoom'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+0' },
      menu: { id: MenuId.MenubarViewMenu, group: '4_zoom', order: 3 },
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).resetZoom()
  }
}
