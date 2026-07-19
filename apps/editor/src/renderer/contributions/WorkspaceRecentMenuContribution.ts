/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Builds the File → Open Recent submenu from IWorkspaceService.recent.
 *  Each recent entry becomes a transient command + menu item; the entries are
 *  rebuilt whenever the recent list changes.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  Disposable,
  DisposableStore,
  IWindowsService,
  IWorkbenchContribution,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  URI,
  localize,
  type IRecentWorkspace,
} from '@universe-editor/platform'
import { ClearRecentWorkspacesAction } from '../actions/workspaceActions.js'

const RECENT_GROUP = '1_recent'
const TRAILING_GROUP = '9_clear'

export class WorkspaceRecentMenuContribution extends Disposable implements IWorkbenchContribution {
  private readonly _dynamic = this._register(new DisposableStore())
  private _openFolders = new Set<string>()

  constructor(
    @IWorkspaceService private readonly workspaceService: IWorkspaceService,
    @IWindowsService private readonly windowsService: IWindowsService,
  ) {
    super()

    // Static parent submenu attachment (always present).
    this._register(
      MenuRegistry.addSubmenuItem(MenuId.MenubarFileMenu, {
        submenu: MenuId.MenubarFileOpenRecentMenu,
        title: localize('action.openRecent.title', 'Open Recent…'),
        group: '2_open',
        order: 2,
      }),
    )

    // Trailing "Clear Recently Opened" — references the already-registered
    // ClearRecentWorkspacesAction command.
    this._register(
      MenuRegistry.addMenuItem(MenuId.MenubarFileOpenRecentMenu, {
        command: ClearRecentWorkspacesAction.ID,
        title: localize('action.clearRecentWorkspaces.title', 'Clear Recently Opened'),
        group: TRAILING_GROUP,
        order: 1,
      }),
    )

    this._rebuild(workspaceService.recent)
    this._register(workspaceService.onDidChangeRecent((next) => this._rebuild(next)))
    this._register(windowsService.onDidChangeWindows(() => void this._refreshOpenFolders()))
    void this._refreshOpenFolders()
  }

  private async _refreshOpenFolders(): Promise<void> {
    try {
      const windows = await this.windowsService.getWindows()
      this._openFolders = new Set(
        windows
          .map((w) => (w.folder ? (URI.revive(w.folder)?.toString() ?? null) : null))
          .filter((s): s is string => s !== null),
      )
    } catch {
      this._openFolders = new Set()
    }
    this._rebuild(this.workspaceService.recent)
  }

  private _rebuild(recent: readonly IRecentWorkspace[]): void {
    this._dynamic.clear()
    recent.forEach((entry, index) => {
      const commandId = `workbench.action.openRecent.${index}`
      this._dynamic.add(
        CommandsRegistry.registerCommand(commandId, () => {
          void this.workspaceService.openFolder(entry.folder)
        }),
      )
      const isOpen = this._openFolders.has(entry.folder.toString())
      this._dynamic.add(
        MenuRegistry.addMenuItem(MenuId.MenubarFileOpenRecentMenu, {
          command: commandId,
          // Full path disambiguates same-named folders in different locations
          // (VSCode shows the full path here too).
          title: entry.folder.fsPath,
          ...(isOpen ? { icon: 'check' } : {}),
          group: RECENT_GROUP,
          order: index,
        }),
      )
    })
  }
}
