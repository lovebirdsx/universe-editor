/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Windows taskbar Jump List: the menu shown when right-clicking the pinned /
 *  taskbar icon. Mirrors VSCode — a "New Window" task plus a custom "Recent
 *  Folders" category driven by the shared recent-workspaces list. No-op on any
 *  non-Windows platform.
 *
 *  Each entry re-launches this executable with args; the single-instance lock in
 *  index.ts routes those args through `second-instance`: a bare launch opens a
 *  fresh window, a folder path opens (or focuses) that workspace.
 *--------------------------------------------------------------------------------------------*/

import { app, type JumpListCategory, type JumpListItem } from 'electron'
import {
  createNamedLogger,
  localize,
  type IDisposable,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import type { RecentWorkspacesMainService } from '../workspace/recentWorkspacesMainService.js'

// Windows is picky about very long titles/descriptions (they silently drop the
// whole entry), so clamp. See microsoft/vscode#111177.
const MAX_LABEL_LEN = 255
// A right-click menu with dozens of entries is unusable; keep it short like VSCode.
const MAX_RECENT_ENTRIES = 7

export class WindowsJumpList implements IDisposable {
  private readonly _logger: ILogger
  private readonly _recentListener: IDisposable
  private _disposed = false

  constructor(
    private readonly _recentWorkspaces: RecentWorkspacesMainService,
    loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'window', name: 'Window' })
    this._recentListener = this._recentWorkspaces.onDidChangeRecent(() => this._update())
    void this._update()
  }

  private async _update(): Promise<void> {
    if (process.platform !== 'win32' || this._disposed) return

    const jumpList: JumpListCategory[] = []

    // Tasks — a bare re-launch is handled by the single-instance `second-instance`
    // handler, which opens a fresh empty window.
    jumpList.push({
      type: 'tasks',
      items: [
        {
          type: 'task',
          title: localize('jumpList.newWindow', 'New Window'),
          description: localize('jumpList.newWindowDesc', 'Opens a new window'),
          program: process.execPath,
          args: '',
          iconPath: process.execPath,
          iconIndex: 0,
        },
      ],
    })

    // Recent Folders — passing the folder fsPath as a positional arg makes
    // `second-instance` open (or focus) that workspace.
    const recent = await this._recentWorkspaces.getRecent()
    const items: JumpListItem[] = recent.slice(0, MAX_RECENT_ENTRIES).map((entry) => {
      const fsPath = entry.folder.fsPath
      return {
        type: 'task',
        title: entry.name.slice(0, MAX_LABEL_LEN),
        description: fsPath.slice(0, MAX_LABEL_LEN),
        program: process.execPath,
        args: `"${fsPath}"`,
        iconPath: 'explorer.exe', // borrow the folder icon
        iconIndex: 0,
      }
    })

    if (items.length > 0) {
      jumpList.push({
        type: 'custom',
        name: localize('jumpList.recentFolders', 'Recent Folders'),
        items,
      })
    }

    try {
      const res = app.setJumpList(jumpList)
      if (res && res !== 'ok') {
        this._logger.warn(`setJumpList unexpected result: ${res}`)
      } else {
        this._logger.debug(`setJumpList ok recentFolders=${items.length}`)
      }
    } catch (error) {
      // setJumpList throws e.g. when the app is not registered with an AppUserModelId.
      this._logger.warn(`setJumpList failed: ${(error as Error).message}`)
    }
  }

  dispose(): void {
    this._disposed = true
    this._recentListener.dispose()
  }
}
