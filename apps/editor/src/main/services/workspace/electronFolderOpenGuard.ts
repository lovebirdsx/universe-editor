/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Electron-backed implementation of IWorkspaceFolderOpenGuard. Mirrors VSCode's
 *  "Path does not exist" info box: one OK button, no "remove from recents?"
 *  prompt (the entry is already gone by the time the box shows).
 *--------------------------------------------------------------------------------------------*/

import { dialog, type BrowserWindow } from 'electron'
import { localize, type ILogger, type URI } from '@universe-editor/platform'
import {
  probeLocalWorkspaceFolder,
  type FolderOpenProbeFailure,
  type IWorkspaceFolderOpenGuard,
} from './folderOpenGuard.js'

export interface ElectronFolderOpenGuardOptions {
  readonly e2eEnabled: boolean
  readonly logger: ILogger
  readonly getParentWindow: () => BrowserWindow | null
}

interface DialogCopy {
  readonly type: 'info' | 'warning'
  readonly message: string
  readonly detail: string
}

function describe(folder: URI, failure: FolderOpenProbeFailure): DialogCopy {
  switch (failure.problem) {
    case 'not-found':
      return {
        type: 'info',
        message: localize('workspace.openFolder.pathMissing.title', 'Path does not exist'),
        detail: localize(
          'workspace.openFolder.pathMissing.detail',
          "The path '{0}' does not exist on this computer.",
          { 0: folder.fsPath },
        ),
      }
    case 'not-a-directory':
      return {
        type: 'info',
        message: localize('workspace.openFolder.notDirectory.title', 'Path is not a folder'),
        detail: localize(
          'workspace.openFolder.notDirectory.detail',
          "The path '{0}' is not a folder.",
          { 0: folder.fsPath },
        ),
      }
    case 'unavailable': {
      const reason =
        failure.error instanceof Error
          ? failure.error.message
          : String(failure.error ?? 'Unknown error')
      return {
        type: 'warning',
        message: localize('workspace.openFolder.unavailable.title', 'Unable to open folder'),
        detail: localize(
          'workspace.openFolder.unavailable.detail',
          "The folder '{0}' could not be opened: {1}",
          { 0: folder.fsPath, 1: reason },
        ),
      }
    }
  }
}

export class ElectronFolderOpenGuard implements IWorkspaceFolderOpenGuard {
  constructor(private readonly _opts: ElectronFolderOpenGuardOptions) {}

  probe(folder: URI): Promise<FolderOpenProbeFailure | null> {
    return probeLocalWorkspaceFolder(folder)
  }

  async report(folder: URI, failure: FolderOpenProbeFailure): Promise<void> {
    if (this._opts.e2eEnabled) {
      this._opts.logger.info(
        `folder open blocked ${folder.toString()} problem=${failure.problem} (e2e: dialog suppressed)`,
      )
      return
    }
    const copy = describe(folder, failure)
    const options = {
      type: copy.type,
      title: copy.message,
      message: copy.message,
      detail: copy.detail,
      buttons: [localize('common.ok', 'OK')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    try {
      const parent = this._opts.getParentWindow()
      if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options)
      else await dialog.showMessageBox(options)
    } catch (err) {
      // A failed dialog must not turn into an unhandled rejection in the open
      // path; the folder stays blocked either way.
      this._opts.logger.warn(`show folder open failure dialog failed ${folder.toString()}`, err)
    }
  }
}
