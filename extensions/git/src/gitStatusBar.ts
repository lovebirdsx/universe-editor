/**
 * The git status-bar entries (branch + ahead/behind sync indicator). A single
 * shared pair of items renders whichever repo is currently active — switching
 * the SCM selection (via `git.setActiveRepo`) re-points these at the new repo,
 * mirroring VSCode's single-repo status bar. Clicking them runs `git-graph.view`
 * / the argument-less `git.sync`, which route to the active repo through
 * `RepositoryManager.resolveRepo`.
 *
 * In a mixed workspace (git repos nested in a p4 client, say) the renderer
 * pushes `git.setActiveRepo` without arguments (or with null, via the
 * nested-args RPC convention) when the selection moves to another provider's
 * repo; `setVisible(false)` hides the pair and keeps it hidden until a git
 * repo is selected again.
 */
import {
  window,
  StatusBarAlignment,
  type Disposable,
  type StatusBarItem,
} from '@universe-editor/extension-api'
import type { RepositoryManager } from './repositoryManager.js'

export class GitStatusBarController {
  private readonly _branchItem: StatusBarItem
  private readonly _syncItem: StatusBarItem
  /** Subscription to the active repo's change signal; swapped on `setActive`. */
  private _repoSub: Disposable | undefined
  /** Hidden by `setVisible(false)` while the SCM selection points at another
   *  provider; `_render` short-circuits so repo change events can't re-show. */
  private _visible = true

  constructor(private readonly _mgr: RepositoryManager) {
    this._branchItem = window.createStatusBarItem(StatusBarAlignment.Left, 100)
    this._branchItem.command = 'git-graph.view'
    this._branchItem.tooltip = 'Open Git Graph'

    this._syncItem = window.createStatusBarItem(StatusBarAlignment.Left, 99)
    this._syncItem.command = 'git.sync'
  }

  /** Re-point the items at the active repo and re-render. Call after the active
   *  repo changes or a new repo is added. */
  refresh(): void {
    const repo = this._mgr.active
    this._repoSub?.dispose()
    this._repoSub = repo?.onDidChange(() => this._render())
    this._render()
  }

  /** Show or hide the whole pair. `false` is pushed via `git.setActiveRepo` when
   *  the SCM selection moved to another provider's repo; `true` restores and
   *  re-renders from the active repo. */
  setVisible(visible: boolean): void {
    this._visible = visible
    if (!visible) {
      this._branchItem.hide()
      this._syncItem.hide()
      return
    }
    this.refresh()
  }

  private _render(): void {
    if (!this._visible) return
    const repo = this._mgr.active
    if (!repo) {
      this._branchItem.hide()
      this._syncItem.hide()
      return
    }
    const { branch, ahead, behind, busy } = repo.status

    this._branchItem.text = `$(git-branch) ${branch ?? 'detached'}`
    this._branchItem.show()

    if (busy) {
      this._syncItem.text = busy.text
      this._syncItem.tooltip = busy.text
      this._syncItem.showProgress = busy.kind
      this._syncItem.show()
      return
    }

    this._syncItem.showProgress = false
    if (ahead > 0 || behind > 0) {
      const parts: string[] = []
      if (ahead > 0) parts.push(`↑${ahead}`)
      if (behind > 0) parts.push(`↓${behind}`)
      this._syncItem.text = parts.join(' ')
      this._syncItem.tooltip = `${ahead} commit(s) ahead, ${behind} behind — click to sync`
      this._syncItem.show()
    } else {
      this._syncItem.hide()
    }
  }

  dispose(): void {
    this._repoSub?.dispose()
    this._branchItem.dispose()
    this._syncItem.dispose()
  }
}
