/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level Action2 commands: new window, restart, close, devtools, about.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IHostService,
  ILoggerService,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class NewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.newWindow'
  constructor() {
    super({
      id: NewWindowAction.ID,
      title: localize('action.newWindow.title', 'New Window'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+shift+n' },
      menu: { id: MenuId.MenubarFileMenu, group: 'z_window', order: 0 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).openNewWindow()
  }
}

export class CloseWindowAction extends Action2 {
  static readonly ID = 'workbench.action.closeWindow'
  constructor() {
    super({
      id: CloseWindowAction.ID,
      title: localize('action.closeWindow.title', 'Close Window'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+shift+w' },
      menu: { id: MenuId.MenubarFileMenu, group: 'z_window', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).closeWindow()
  }
}

export class RestartEditorAction extends Action2 {
  static readonly ID = 'workbench.action.restartEditor'
  constructor() {
    super({
      id: RestartEditorAction.ID,
      title: localize('action.restartEditor.title', 'Restart Editor'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+alt+r' },
      menu: { id: MenuId.MenubarFileMenu, group: 'z_window', order: 0 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).restart()
  }
}

export class ToggleDevToolsAction extends Action2 {
  static readonly ID = 'workbench.action.toggleDevTools'
  constructor() {
    super({
      id: ToggleDevToolsAction.ID,
      title: localize('action.toggleDeveloperTools.title', 'Toggle Developer Tools'),
      category: localize('command.category.help', 'Help'),
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
      title: localize('action.about.title', 'About Universe Editor'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: 'z_about', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor
      .get(ILoggerService)
      .createLogger({ id: 'action', name: 'Action' })
      .info(localize('app.description', 'A VSCode-paradigm game content editor.'))
  }
}
