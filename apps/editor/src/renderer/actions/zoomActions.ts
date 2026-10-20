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
import { IWorkbenchWindowService } from '../services/windows/workbenchWindowService.js'
import { IAuxiliaryEditorWindowService } from '../services/windows/auxiliaryEditorWindowService.js'

const CATEGORY = localize2('command.category.view', 'View')

/**
 * Zoom applies to the focused workbench window: auxiliary windows are separate
 * Chromium webContents with their own zoom level.
 */
function zoomFocusedWindow(
  accessor: ServicesAccessor,
  action: 'zoomIn' | 'zoomOut' | 'resetZoom',
): void {
  const active = accessor.get(IWorkbenchWindowService).activeWindow
  if (!active.isMain && active.token !== undefined) {
    const auxiliary = accessor.get(IAuxiliaryEditorWindowService).getWindowForToken(active.token)
    if (auxiliary) {
      void accessor.get(IAuxiliaryEditorWindowService)[action](auxiliary)
      return
    }
  }
  void accessor.get(IHostService)[action]()
}

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
    zoomFocusedWindow(accessor, 'zoomIn')
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
    zoomFocusedWindow(accessor, 'zoomOut')
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
    zoomFocusedWindow(accessor, 'resetZoom')
  }
}
