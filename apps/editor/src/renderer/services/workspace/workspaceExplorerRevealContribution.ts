/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceExplorerRevealContribution — whenever a folder is opened (via the
 *  dialog action, the "Open Recent" submenu, or the E2E probe), make the primary
 *  side bar visible and switch it to the Explorer view container so the file tree
 *  is immediately visible to the user.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  PartId,
  type IWorkbenchContribution,
} from '@universe-editor/platform'

export class WorkspaceExplorerRevealContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IWorkspaceService workspaceService: IWorkspaceService,
    @ILayoutService private readonly _layoutService: ILayoutService,
    @IViewsService private readonly _viewsService: IViewsService,
  ) {
    super()
    this._register(
      workspaceService.onDidChangeWorkspace((workspace) => {
        if (!workspace) return
        this._revealExplorer()
      }),
    )
  }

  private _revealExplorer(): void {
    this._layoutService.setVisible(PartId.SideBar, true)
    this._viewsService.openViewContainer('workbench.view.explorer')
  }
}
