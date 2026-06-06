/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level Action2 commands: new window, restart, close, devtools, about.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  getDisposableTracker,
  IDialogService,
  IHostService,
  ILifecycleService,
  IQuickInputService,
  IWindowsService,
  MenuId,
  ShutdownReason,
  URI,
  localize,
  type DisposableTracker,
  type IQuickPickItem,
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

export class OpenFolderInNewWindowAction extends Action2 {
  static readonly ID = 'workbench.action.files.openFolderInNewWindow'
  constructor() {
    super({
      id: OpenFolderInNewWindowAction.ID,
      title: localize('action.openFolderInNewWindow.title', 'Open Folder in New Window…'),
      category: localize('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 4 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWindowsService).openWindow()
  }
}

interface WindowPickItem extends IQuickPickItem {
  readonly windowId: number
}

export class SwitchWindowAction extends Action2 {
  static readonly ID = 'workbench.action.switchWindow'
  constructor() {
    super({
      id: SwitchWindowAction.ID,
      title: localize('action.switchWindow.title', 'Switch Window…'),
      category: localize('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: 'z_window', order: 2 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const windowsService = accessor.get(IWindowsService)
    const quickInput = accessor.get(IQuickInputService)
    const windows = await windowsService.getWindows()
    if (windows.length === 0) return
    const items: WindowPickItem[] = windows.map((w) => {
      const folder = w.folder ? URI.revive(w.folder) : null
      return {
        id: `window.${w.id}`,
        label: w.name ?? localize('window.untitled', 'Untitled (Window {id})', { id: w.id }),
        ...(folder ? { description: folder.fsPath } : {}),
        windowId: w.id,
      }
    })
    const pick = await quickInput.pick<WindowPickItem>(items, {
      placeholder: localize('quickInput.switchWindow.placeholder', 'Select a window to switch to'),
      matchOnDescription: true,
    })
    if (!pick) return
    await windowsService.focusWindow(pick.windowId)
  }
}

export class ExitAction extends Action2 {
  static readonly ID = 'workbench.action.quit'
  constructor() {
    super({
      id: ExitAction.ID,
      title: localize('action.exit.title', 'Exit'),
      category: localize('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: 'z_exit', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWindowsService).quit()
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
    const lifecycleService = accessor.get(ILifecycleService)
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
        // Echo to the `pnpm dev` terminal: renderer console output never reaches
        // it, so without this the leaks shown in the modal would only ever live
        // in this window. Fire-and-forget; the modal is the dev-facing surface.
        void leakService!.printLeaks({
          count: report.leaks.length,
          details: report.details,
          capturedAt: Date.now(),
          source: 'restart',
        })
        const choice = await dialogService!.confirm({
          type: 'warning',
          message: localize(
            'restart.leakDetected.message',
            'Detected {count} un-disposed Disposable(s)',
            { count: report.leaks.length },
          ),
          detail: report.details,
          primaryButton: localize('restart.leakDetected.restart', 'Restart Anyway'),
          cancelButton: localize('common.cancel', 'Cancel'),
          copyButton: localize('common.copy', 'Copy'),
        })
        if (!choice.confirmed) return
      }
      leakService!.markUnloadReason('restart')
    }
    if (await lifecycleService.confirmBeforeShutdown(ShutdownReason.Reload)) return
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

  override async run(accessor: ServicesAccessor): Promise<void> {
    const hostService = accessor.get(IHostService)
    const dialogService = accessor.get(IDialogService)
    const info = await hostService.getVersionInfo()
    const detail = localize(
      'about.detail',
      'Version: {version}\nElectron: {electron}\nChromium: {chromium}\nNode: {node}\nV8: {v8}',
      {
        version: info.version,
        electron: info.electron,
        chromium: info.chromium,
        node: info.node,
        v8: info.v8,
      },
    )
    await dialogService.confirm({
      type: 'info',
      message: `${info.productName}\n${localize('app.description', 'A VSCode-paradigm game content editor.')}`,
      detail,
      primaryButton: localize('common.ok', 'OK'),
      copyButton: localize('common.copy', 'Copy'),
    })
  }
}
