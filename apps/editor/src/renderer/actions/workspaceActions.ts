/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace-related Action2 commands: Open Folder, Open Recent, Clear Recent,
 *  Close Folder. The actual fs / dialog work is delegated to IWorkspaceService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IHostService,
  ILifecycleService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  IWindowsService,
  IWorkspaceService,
  MenuId,
  ProgressLocation,
  Severity,
  ShutdownReason,
  URI,
  localize,
  type IKeyMods,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'

export class OpenFolderAction extends Action2 {
  static readonly ID = 'workbench.action.files.openFolder'
  constructor() {
    super({
      id: OpenFolderAction.ID,
      title: localize('action.openFolder.title', 'Open Folder…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: ['ctrl+k', 'ctrl+o'] },
      menu: { id: MenuId.MenubarFileMenu, group: '2_open', order: 1 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const lifecycle = accessor.get(ILifecycleService)
    const workspace = accessor.get(IWorkspaceService)
    const progress = accessor.get(IProgressService)
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await progress.withProgress(
      {
        location: ProgressLocation.Window,
        title: localize('progress.openFolder', 'Opening folder…'),
        source: 'workspace',
      },
      () => workspace.openFolder(),
    )
  }
}

export class CloseFolderAction extends Action2 {
  static readonly ID = 'workbench.action.closeFolder'
  constructor() {
    super({
      id: CloseFolderAction.ID,
      title: localize('action.closeFolder.title', 'Close Folder'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const lifecycle = accessor.get(ILifecycleService)
    const workspace = accessor.get(IWorkspaceService)
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await workspace.closeFolder()
  }
}

export class OpenWorkspaceInVSCodeAction extends Action2 {
  static readonly ID = 'workbench.action.openWorkspaceInVSCode'
  constructor() {
    super({
      id: OpenWorkspaceInVSCodeAction.ID,
      title: localize('action.openWorkspaceInVSCode.title', 'Open Workspace in VS Code'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+alt+e' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const workspace = accessor.get(IWorkspaceService)
    const host = accessor.get(IHostService)
    const cwd = workspace.current?.folder.fsPath ?? null
    if (!cwd) return
    const error = await host.openInVSCode(cwd)
    if (error) {
      accessor.get(INotificationService).notify({
        severity: Severity.Error,
        message: localize(
          'action.openWorkspaceInVSCode.failed',
          'Failed to open VS Code. Make sure the `code` command is on your PATH.',
        ),
      })
    }
  }
}

interface RecentPickItem extends IQuickPickItem {
  readonly index: number
}

export class OpenRecentAction extends Action2 {
  static readonly ID = 'workbench.action.openRecent'
  constructor() {
    super({
      id: OpenRecentAction.ID,
      title: localize('action.openRecent.title', 'Open Recent…'),
      category: localize('command.category.file', 'File'),
      keybinding: { primary: 'ctrl+r' },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const lifecycle = accessor.get(ILifecycleService)
    const workspace = accessor.get(IWorkspaceService)
    const quickInput = accessor.get(IQuickInputService)
    const progress = accessor.get(IProgressService)
    const windowsService = accessor.get(IWindowsService)
    const recent = workspace.recent
    if (recent.length === 0) return

    let openFolders = new Set<string>()
    try {
      const windows = await windowsService.getWindows()
      openFolders = new Set(
        windows
          .map((w) => (w.folder ? (URI.revive(w.folder)?.toString() ?? null) : null))
          .filter((s): s is string => s !== null),
      )
    } catch {
      // Best-effort: without open-state we just omit the markers.
    }

    const openedBadge = localize('workspace.recent.opened', 'Opened')
    const items: RecentPickItem[] = recent.map((r, index) => {
      const isOpen = openFolders.has(r.folder.toString())
      return {
        id: `recent.${index}`,
        label: r.name,
        description: r.folder.fsPath,
        ...(isOpen ? { keybinding: openedBadge } : {}),
        index,
      }
    })

    const keyMods: IKeyMods = { ctrl: false, alt: false }
    const pick = await quickInput.pick<RecentPickItem>(items, {
      placeholder: localize('quickInput.openRecent.placeholder', 'Open Recent'),
      matchOnDescription: true,
      keyMods,
      onItemRemove: (item) => {
        const entry = recent[(item as RecentPickItem).index]
        if (entry) void workspace.removeRecent(entry.folder)
      },
    })
    if (!pick) return
    const target = recent[pick.index]
    if (!target) return
    // Ctrl held → open in a new window; otherwise open in this window (the main
    // process focuses an existing window if the folder is already open elsewhere).
    if (keyMods.ctrl) {
      await windowsService.openWindow(target.folder)
      return
    }
    // Same-window switch: confirm before interrupting any running session.
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
    await progress.withProgress(
      {
        location: ProgressLocation.Window,
        title: localize('progress.openRecent', 'Opening {name}…', { name: target.name }),
        source: 'workspace',
      },
      () => workspace.openFolder(target.folder),
    )
  }
}

export class ClearRecentWorkspacesAction extends Action2 {
  static readonly ID = 'workbench.action.clearRecentlyOpened'
  constructor() {
    super({
      id: ClearRecentWorkspacesAction.ID,
      title: localize('action.clearRecentWorkspaces.title', 'Clear Recently Opened'),
      category: localize('command.category.file', 'File'),
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWorkspaceService).clearRecent()
  }
}
