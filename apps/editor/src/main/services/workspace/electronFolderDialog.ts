/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-backed folder picker used by WorkspaceMainService. Kept in a
 *  separate file so the service can be unit-tested with a stub IFolderDialog.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, dialog } from 'electron'
import { URI } from '@universe-editor/platform'
import type { IFolderDialog } from './workspaceMainService.js'

export class ElectronFolderDialog implements IFolderDialog {
  async showOpenFolderDialog(): Promise<URI | null> {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const first = result.filePaths[0]
    if (!first) return null
    return URI.file(first)
  }
}
