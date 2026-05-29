/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowTitleContribution — keeps the native window title in sync with the
 *  current workspace folder so Alt+Tab / the taskbar shows which workspace each
 *  window belongs to (e.g. "universe-editor5 - D:\git_project", i.e.
 *  "<folder name> - <parent directory>"). Electron mirrors `document.title`
 *  onto the native window title, which the window manager surfaces even with
 *  `frame: false`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkspaceService,
  localize,
  type IWorkspace,
  type IWorkbenchContribution,
} from '@universe-editor/platform'

export class WindowTitleContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IWorkspaceService private readonly _workspaceService: IWorkspaceService) {
    super()
    this._update(this._workspaceService.current)
    this._register(this._workspaceService.onDidChangeWorkspace((w) => this._update(w)))
    void this._workspaceService.whenReady.then(() => this._update(this._workspaceService.current))
  }

  private _update(workspace: IWorkspace | null): void {
    const appName = localize('app.name', 'Universe Editor')
    if (!workspace) {
      document.title = appName
      return
    }
    const parentPath = workspace.folder.path.replace(/\/[^/]+\/?$/, '')
    const parent = workspace.folder.with({ path: parentPath }).fsPath
    document.title = `${workspace.name} - ${parent}`
  }
}
