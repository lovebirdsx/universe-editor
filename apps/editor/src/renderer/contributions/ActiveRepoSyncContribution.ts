/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Pushes the SCM view's currently-selected repository to the git extension host
 *  via `git.setActiveRepo`. The selection lives in the renderer (scmViewState),
 *  but argument-less git commands (command palette, keybindings, status-bar
 *  clicks) execute in the extension host, where `RepositoryManager` falls back to
 *  the active repo. Keeping the host's active repo in sync with the view makes
 *  those entry points operate on the repo the user is actually looking at.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  IWorkbenchContribution,
  autorun,
} from '@universe-editor/platform'
import { IScmService } from '../services/extensions/ScmService.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'

export class ActiveRepoSyncContribution extends Disposable implements IWorkbenchContribution {
  private _lastPushed: string | undefined

  constructor(
    @IScmService scmService: IScmService,
    @ICommandService private readonly _commandService: ICommandService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const sourceControls = scmService.sourceControls.read(r)
        const selectedRootUri = scmViewState.selectedRepo.read(r)
        // Mirror ScmView / ScmViewToolbar: the shown repo is the selected one, or
        // the first when the selection is unset or no longer present.
        const active =
          sourceControls.find((sc) => sc.rootUri === selectedRootUri) ?? sourceControls[0]
        this._push(active?.rootUri)
      }),
    )
  }

  private _push(rootUri: string | undefined): void {
    if (!rootUri || rootUri === this._lastPushed) return
    this._lastPushed = rootUri
    void this._commandService.executeCommand('git.setActiveRepo', rootUri)
  }
}
