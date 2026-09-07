/*---------------------------------------------------------------------------------------------
 *  GitGraphViewResetContribution — the Git Graph editor holds module-level state
 *  (gitGraphViewState) so a re-activated tab rehydrates instantly instead of
 *  reloading. That state is per-workspace: switching workspaces (including to a
 *  git worktree of the same repo) must drop it, otherwise the previous
 *  workspace's repo root is re-asserted onto the freshly restarted extension via
 *  `git-graph.setRepo`, silently re-pointing every graph mutation (e.g. Reset
 *  current branch) at the OLD workspace's checkout. Clear it when the workspace
 *  root actually changes (including closing the folder); the first observation
 *  (startup hydration / opening the first folder) must not clear.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkspaceService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { GIT_GRAPH_PAGE_SIZE, gitGraphViewState } from '../services/gitGraph/gitGraphViewState.js'

export class GitGraphViewResetContribution extends Disposable implements IWorkbenchContribution {
  private _lastFolderKey: string | undefined

  constructor(@IWorkspaceService workspaceService: IWorkspaceService) {
    super()
    this._lastFolderKey = workspaceService.current?.folder.toString()
    this._register(
      workspaceService.onDidChangeWorkspace((workspace) => {
        const key = workspace?.folder.toString()
        if (this._lastFolderKey !== undefined && key !== this._lastFolderKey) {
          resetGitGraphViewState()
        }
        this._lastFolderKey = key
      }),
    )
  }
}

/** Drop the per-workspace view state. User preferences that are shared across
 *  workspaces (view settings, column widths) are kept; the callbacks
 *  (focusSearch/focusRows/…) belong to the mounted editor and are re-registered
 *  by the next mount. */
function resetGitGraphViewState(): void {
  gitGraphViewState.result = null
  gitGraphViewState.selection = []
  gitGraphViewState.scrollTop = 0
  gitGraphViewState.searchQuery = ''
  gitGraphViewState.limit = GIT_GRAPH_PAGE_SIZE
  gitGraphViewState.repos = []
  gitGraphViewState.selectedRepo = null
  gitGraphViewState.pendingReveal.set(null, undefined)
}
