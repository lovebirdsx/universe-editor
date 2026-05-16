/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level Action2 commands: close, devtools, about.
 *--------------------------------------------------------------------------------------------*/

import { Action2, IHostService, MenuId, type ServicesAccessor } from '@universe-editor/platform'

export class CloseWindowAction extends Action2 {
  static readonly ID = 'workbench.action.closeWindow'
  constructor() {
    super({
      id: CloseWindowAction.ID,
      title: 'Close Window',
      category: 'File',
      keybinding: { primary: 'ctrl+shift+w' },
      menu: { id: MenuId.MenubarFileMenu, group: 'z_window', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).closeWindow()
  }
}

export class ToggleDevToolsAction extends Action2 {
  static readonly ID = 'workbench.action.toggleDevTools'
  constructor() {
    super({
      id: ToggleDevToolsAction.ID,
      title: 'Toggle Developer Tools',
      category: 'Help',
      keybinding: { primary: 'ctrl+shift+i' },
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).toggleDevTools()
  }
}

export class AboutAction extends Action2 {
  static readonly ID = 'workbench.action.about'
  constructor() {
    super({
      id: AboutAction.ID,
      title: 'About Universe Editor',
      category: 'Help',
      menu: { id: MenuId.MenubarHelpMenu, group: 'z_about', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    // Avoid touching the accessor — keep AboutAction reachable even before
    // optional services are wired. A real dialog comes in a later milestone.
    void accessor

    console.info('Universe Editor — desktop game content editor.')
  }
}
