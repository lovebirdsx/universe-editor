/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-update commands. CheckForUpdates is user-facing (command palette); the
 *  download / install commands back the status-bar entry + notification actions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  INotificationService,
  MenuId,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
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
    const update = accessor.get(IUpdateService)
    const notification = accessor.get(INotificationService)
    const handle = notification.status(localize('update.checking', 'Checking for updates…'))
    try {
      await update.checkForUpdates()
      const state = await update.getState()
      // 'available' is surfaced by UpdateContribution's notification; don't repeat it.
      if (state.status === 'not-available') {
        notification.notify({
          severity: Severity.Info,
          message: localize('update.upToDate', 'You are running the latest version ({version}).', {
            version: state.currentVersion,
          }),
        })
      } else if (state.status === 'error') {
        notification.notify({
          severity: Severity.Warning,
          message: localize('update.checkFailed', 'Could not check for updates: {error}', {
            error: state.error ?? '',
          }),
        })
      }
    } finally {
      handle.dispose()
    }
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
