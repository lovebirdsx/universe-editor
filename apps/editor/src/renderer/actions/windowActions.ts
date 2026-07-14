/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Window-level Action2 commands: new window, restart, close, devtools, about.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  getDisposableTracker,
  IDialogService,
  IFileDialogService,
  IHostService,
  ILifecycleService,
  IQuickInputService,
  IWindowsService,
  IWorkspaceService,
  MenuId,
  ShutdownReason,
  URI,
  localize,
  localize2,
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
      title: localize2('action.newWindow.title', 'New Window'),
      category: localize2('command.category.file', 'File'),
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
      title: localize2('action.closeWindow.title', 'Close Window'),
      category: localize2('command.category.file', 'File'),
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
      title: localize2('action.openFolderInNewWindow.title', 'Open Folder in New Window…'),
      category: localize2('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 4 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Resolve all services synchronously up front: the accessor is only valid
    // during invokeFunction's call, not across the showOpenDialog await.
    const fileDialog = accessor.get(IFileDialogService)
    const workspace = accessor.get(IWorkspaceService)
    const windowsService = accessor.get(IWindowsService)
    const folder = await fileDialog.showOpenDialog({
      title: localize('fileDialog.openFolder.title', 'Open Folder'),
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: localize('fileDialog.openFolderButton', 'Open'),
      ...(workspace.current ? { defaultUri: workspace.current.folder } : {}),
    })
    if (!folder) return
    await windowsService.openWindow(folder)
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
      title: localize2('action.switchWindow.title', 'Switch Window…'),
      category: localize2('command.category.file', 'File'),
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
      title: localize2('action.exit.title', 'Exit'),
      category: localize2('command.category.file', 'File'),
      menu: { id: MenuId.MenubarFileMenu, group: 'zz_exit', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWindowsService).quit()
  }
}

export class ReloadWindowAction extends Action2 {
  static readonly ID = 'workbench.action.reloadWindow'
  constructor() {
    super({
      id: ReloadWindowAction.ID,
      title: localize2('action.reloadWindow.title', 'Reload Window'),
      category: localize2('command.category.file', 'File'),
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
    // Label the leak report that the beforeunload handler will persist. The
    // detection itself runs there (main.tsx), which unmounts React *before*
    // snapshotting so active useEffect subscriptions aren't counted as false
    // leaks — doing it here (React still mounted) would report every live
    // subscription. E2E has its own sessionStorage-based detection, so skip.
    const isE2E = typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true
    if (!isE2E && getDisposableTracker() !== null) {
      accessor.get(IRendererDisposableLeakService).markUnloadReason('reload')
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
      title: localize2('action.toggleDeveloperTools.title', 'Toggle Developer Tools'),
      category: localize2('command.category.help', 'Help'),
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
      title: localize2('action.openUserDataFolder.title', 'Developer: Open User Data Folder'),
      category: localize2('command.category.help', 'Help'),
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
      title: localize2('action.about.title', 'About Universe Editor'),
      category: localize2('command.category.help', 'Help'),
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
