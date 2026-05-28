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
  IWorkbenchContribution,
  IWorkspaceService,
  MenuId,
  MenuRegistry,
  localize,
  type IRecentWorkspace,
} from '@universe-editor/platform'
import { ClearRecentWorkspacesAction } from '../actions/workspaceActions.js'

const RECENT_GROUP = '1_recent'
const TRAILING_GROUP = '9_clear'

export class WorkspaceRecentMenuContribution extends Disposable implements IWorkbenchContribution {
  private readonly _dynamic = this._register(new DisposableStore())

  constructor(@IWorkspaceService private readonly workspaceService: IWorkspaceService) {
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
      this._dynamic.add(
        MenuRegistry.addMenuItem(MenuId.MenubarFileOpenRecentMenu, {
          command: commandId,
          title: entry.name,
          group: RECENT_GROUP,
          order: index,
        }),
      )
    })
  }
}
