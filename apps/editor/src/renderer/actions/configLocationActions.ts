/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Actions for the config directory: where user settings.json / keybindings.json
 *  load from (VSCode Portable style). Set / open / reset, all hot-reloaded.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  IHostService,
  INotificationService,
  MenuId,
  Severity,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'

const CATEGORY = localize('command.category.preferences', 'Preferences')

export class SetConfigLocationAction extends Action2 {
  static readonly ID = 'workbench.action.setConfigLocation'
  constructor() {
    super({
      id: SetConfigLocationAction.ID,
      title: localize('action.setConfigLocation.title', 'Set Config Directory…'),
      category: CATEGORY,
      menu: { id: MenuId.MenubarFileMenu, group: '5_preferences', order: 10 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const configLocation = accessor.get(IConfigLocationService)
    const dialog = accessor.get(IDialogService)
    const notification = accessor.get(INotificationService)

    const info = await configLocation.getInfo()
    if (info.locked) {
      notification.notify({
        severity: Severity.Warning,
        message: localize(
          'configLocation.locked',
          'The config directory is fixed by a command-line / environment override and cannot be changed here.',
        ),
      })
      return
    }

    const dir = await configLocation.pickConfigDir()
    if (!dir) return
    if (dir === info.dir) return

    const result = await dialog.confirm({
      type: 'info',
      message: localize('configLocation.confirm.message', 'Switch config directory to:'),
      detail: dir,
      primaryButton: localize('configLocation.confirm.copy', 'Copy Current Settings'),
      secondaryButton: localize('configLocation.confirm.empty', "Don't Copy"),
      cancelButton: localize('common.cancel', 'Cancel'),
    })
    if (result.choice === 'cancel') return

    const copyCurrent = result.choice === 'primary'
    if (copyCurrent && (await configLocation.isDirNonEmpty(dir))) {
      const overwrite = await dialog.confirm({
        type: 'warning',
        message: localize(
          'configLocation.confirmNonEmpty.message',
          'The target directory is not empty. Copy current settings into it anyway?',
        ),
        detail: localize(
          'configLocation.confirmNonEmpty.detail',
          'Existing settings.json / keybindings.json in {dir} will be kept; only missing files are copied.',
          { dir },
        ),
        primaryButton: localize('configLocation.confirmNonEmpty.proceed', 'Copy Anyway'),
        cancelButton: localize('common.cancel', 'Cancel'),
      })
      if (!overwrite.confirmed) return
    }

    const ok = await configLocation.setConfigDir(dir, copyCurrent)
    if (ok) {
      notification.notify({
        severity: Severity.Info,
        message: localize('configLocation.switched', 'Config directory switched to {dir}.', {
          dir,
        }),
      })
    }
  }
}

export class OpenConfigLocationFolderAction extends Action2 {
  static readonly ID = 'workbench.action.openConfigLocationFolder'
  constructor() {
    super({
      id: OpenConfigLocationFolderAction.ID,
      title: localize('action.openConfigLocationFolder.title', 'Open Config Directory'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const configLocation = accessor.get(IConfigLocationService)
    const host = accessor.get(IHostService)
    const info = await configLocation.getInfo()
    await host.showItemInFolder(info.dir)
  }
}

export class ResetConfigLocationAction extends Action2 {
  static readonly ID = 'workbench.action.resetConfigLocation'
  constructor() {
    super({
      id: ResetConfigLocationAction.ID,
      title: localize('action.resetConfigLocation.title', 'Reset Config Directory to Default'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const configLocation = accessor.get(IConfigLocationService)
    const notification = accessor.get(INotificationService)
    const info = await configLocation.getInfo()
    if (info.locked) {
      notification.notify({
        severity: Severity.Warning,
        message: localize(
          'configLocation.locked',
          'The config directory is fixed by a command-line / environment override and cannot be changed here.',
        ),
      })
      return
    }
    const ok = await configLocation.resetToDefault()
    if (ok) {
      notification.notify({
        severity: Severity.Info,
        message: localize('configLocation.reset', 'Config directory reset to default.'),
      })
    }
  }
}
