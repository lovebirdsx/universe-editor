/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update commands. CheckForUpdates is user-facing (command palette); the
 *  download / install commands back the status-bar entry + notification actions.
 *--------------------------------------------------------------------------------------------*/

import { Action2, MenuId, localize2, type ServicesAccessor } from '@universe-editor/platform'
import { IUpdateService } from '../../shared/ipc/updateService.js'

export class CheckForUpdatesAction extends Action2 {
  static readonly ID = 'workbench.action.checkForUpdates'
  constructor() {
    super({
      id: CheckForUpdatesAction.ID,
      title: localize2('update.check', 'Check for Updates'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: 'm_updates', order: 1 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // explicit=true: the outcome ("up to date" / "check failed" / "available")
    // is surfaced by UpdateContribution off the resulting state change.
    await accessor.get(IUpdateService).checkForUpdates(true)
  }
}

export class DownloadUpdateAction extends Action2 {
  static readonly ID = 'workbench.action.downloadUpdate'
  constructor() {
    super({
      id: DownloadUpdateAction.ID,
      title: localize2('update.download', 'Download Update'),
      category: localize2('command.category.help', 'Help'),
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IUpdateService).downloadUpdate()
  }
}

export class InstallUpdateAction extends Action2 {
  static readonly ID = 'workbench.action.installUpdate'
  constructor() {
    super({
      id: InstallUpdateAction.ID,
      title: localize2('update.restart', 'Restart to Update'),
      category: localize2('command.category.help', 'Help'),
      f1: false,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IUpdateService).quitAndInstall()
  }
}
