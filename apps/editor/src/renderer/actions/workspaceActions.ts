/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace-related Action2 commands: Open Folder, Open Recent, Clear Recent,
 *  Close Folder. The actual fs / dialog work is delegated to IWorkspaceService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IQuickInputService,
  IWorkspaceService,
  MenuId,
  localize,
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

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWorkspaceService).openFolder()
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

  override run(accessor: ServicesAccessor): void {
    void accessor.get(IWorkspaceService).closeFolder()
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
    const workspace = accessor.get(IWorkspaceService)
    const quickInput = accessor.get(IQuickInputService)
    const recent = workspace.recent
    if (recent.length === 0) return
    const items: RecentPickItem[] = recent.map((r, index) => ({
      id: `recent.${index}`,
      label: r.name,
      description: r.folder.fsPath,
      index,
    }))
    const pick = await quickInput.pick<RecentPickItem>(items, {
      placeholder: localize('quickInput.openRecent.placeholder', 'Open Recent'),
    })
    if (!pick) return
    const target = recent[pick.index]
    if (target) await workspace.openFolder(target.folder)
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
