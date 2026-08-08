/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommitChangesViewResetContribution — the Commit Changes sidebar view holds
 *  module-level state (commitChangesViewState) that survives nothing else:
 *  without this hook, switching workspaces left the previous workspace's
 *  commit content on screen. Clear it when the workspace root actually
 *  changes (including closing the folder); the first observation (startup
 *  hydration / opening the first folder) must not clear.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkspaceService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { commitChangesViewState } from '../workbench/scm/commitChanges/viewState.js'

export class CommitChangesViewResetContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private _lastFolderKey: string | undefined

  constructor(@IWorkspaceService workspaceService: IWorkspaceService) {
    super()
    this._lastFolderKey = workspaceService.current?.folder.toString()
    this._register(
      workspaceService.onDidChangeWorkspace((workspace) => {
        const key = workspace?.folder.toString()
        if (this._lastFolderKey !== undefined && key !== this._lastFolderKey) {
          commitChangesViewState.clear()
        }
        this._lastFolderKey = key
      }),
    )
  }
}
