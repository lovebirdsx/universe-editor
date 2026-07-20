/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WorkspaceExplorerRevealContribution — whenever a folder is opened (via the
 *  dialog action, the "Open Recent" submenu, or the E2E probe), make the primary
 *  side bar visible and switch it to the Explorer view container so the file tree
 *  is immediately visible to the user — UNLESS the user has already switched to a
 *  non-Explorer container (Search / SCM / Agents), in which case their selection
 *  is preserved. `onDidChangeWorkspace` is async, so an opened folder must not
 *  clobber a container the user activated in the same tick (e.g. clicking Search
 *  right after opening a folder).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  PartId,
  ViewContainerLocation,
  type IWorkbenchContribution,
} from '@universe-editor/platform'

const EXPLORER_CONTAINER_ID = 'workbench.view.explorer'

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
    // Only auto-reveal Explorer when the side bar shows nothing yet or is still
    // on Explorer. A user (or a command) that has already switched the primary
    // side bar to another container keeps that choice.
    const active = this._viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar)
    if (active !== undefined && active !== EXPLORER_CONTAINER_ID) return
    this._layoutService.setVisible(PartId.SideBar, true)
    this._viewsService.openViewContainer(EXPLORER_CONTAINER_ID)
  }
}
