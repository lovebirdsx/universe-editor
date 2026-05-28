/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level Action2 commands: new window, restart, close, devtools, about.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  getDisposableTracker,
  IDialogService,
  IHostService,
  ILoggerService,
  MenuId,
  localize,
  type DisposableTracker,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'
import { IRendererDisposableLeakService } from '../services/disposableLeak/DisposableLeakService.js'

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

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Resolve all services synchronously up front: the accessor is only valid
    // during invokeFunction's call, not across awaits.
    const hostService = accessor.get(IHostService)
    const tracker = getDisposableTracker() as DisposableTracker | null
    // E2E spec has its own sessionStorage-based leak detection and runs
    // headless, so a modal would hang the test. Skip the modal in E2E.
    const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    const trackerActive =
      tracker !== null && !isE2E && typeof tracker.computeLeakingDisposables === 'function'
    const dialogService = trackerActive ? accessor.get(IDialogService) : null
    const leakService = trackerActive ? accessor.get(IRendererDisposableLeakService) : null

    // Dev/E2E only: surface any pending Disposable leaks with a modal before
    // reloading, since beforeunload's console.warn is too easy to miss.
    // Production has no tracker installed, so this branch is skipped.
    if (trackerActive && tracker) {
      const report = tracker.computeLeakingDisposables()
      if (report) {
        const choice = await dialogService!.confirm({
          type: 'warning',
          message: localize(
            'restart.leakDetected.message',
            'Detected {count} un-disposed Disposable(s)',
            { count: report.leaks.length },
          ),
          detail: report.details.slice(0, 2000),
          primaryButton: localize('restart.leakDetected.restart', 'Restart Anyway'),
          cancelButton: localize('common.cancel', 'Cancel'),
        })
        if (!choice.confirmed) return
      }
      leakService!.markUnloadReason('restart')
    }
    await hostService.restart()
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

export class OpenUserDataFolderAction extends Action2 {
  static readonly ID = 'workbench.action.openUserDataFolder'
  constructor() {
    super({
      id: OpenUserDataFolderAction.ID,
      title: localize('action.openUserDataFolder.title', 'Developer: Open User Data Folder'),
      category: localize('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 3 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IHostService).openUserDataFolder()
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
