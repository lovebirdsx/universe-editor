/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-backed folder picker used by WorkspaceMainService. Kept in a
 *  separate file so the service can be unit-tested with a stub IFolderDialog.
 *  Bound to a specific window so the dialog is modal to the requesting window.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow, dialog } from 'electron'
import { URI } from '@universe-editor/platform'
import type { IFolderDialog } from './workspaceMainService.js'

export class ElectronFolderDialog implements IFolderDialog {
  constructor(private readonly _win: BrowserWindow) {}

  async showOpenFolderDialog(): Promise<URI | null> {
    const result = await dialog.showOpenDialog(this._win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const first = result.filePaths[0]
    if (!first) return null
    return URI.file(first)
  }
}
