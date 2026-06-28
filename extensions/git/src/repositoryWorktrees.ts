/**
 * Worktree operations for a repository: list / create / open / delete, including
 * the failure-classification retries (busy → notify, dirty/locked → force,
 * submodules → deinit + force). Split out of repository.ts; it talks to the
 * repository through a narrow {@link WorktreeHost} so it can reuse the core's
 * progress + refresh plumbing without owning SCM state.
 */
import { basename, dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { commands, window, type QuickPickItem } from '@universe-editor/extension-api'
import { gitExec } from './gitService.js'
import { gitErrorText, notifyGitFailure } from './gitError.js'
import { parseWorktrees, type WorktreeInfo } from './worktreeParser.js'
import { classifyWorktreeRemoveFailure } from './repositoryTypes.js'

/** The slice of the repository the worktree operations need. */
export interface WorktreeHost {
  readonly root: string
  readonly log?: (msg: string) => void
  beginProgress(text: string, kind: 'syncing' | 'spinning'): void
  endProgress(): void
  refresh(): Promise<void>
  listBranches(): Promise<string[]>
  /** Run a git command with the core's progress + auto-refresh, returning success. */
  run(
    args: readonly string[],
    label: string,
    progress?: { text: string; kind: 'syncing' | 'spinning' },
  ): Promise<boolean>
}

export class RepositoryWorktrees {
  constructor(private readonly _host: WorktreeHost) {}

  private get _root(): string {
    return this._host.root
  }
  private get _log(): ((msg: string) => void) | undefined {
    return this._host.log
  }

  private async _listWorktrees(): Promise<WorktreeInfo[]> {
    const res = await gitExec(['worktree', 'list', '--porcelain'], this._root, this._log)
    if (res.exitCode !== 0) return []
    return parseWorktrees(res.stdout)
  }

  /** Human-readable ref for a worktree: its branch, short detached HEAD, or bare. */
  private _worktreeRef(wt: WorktreeInfo): string {
    if (wt.bare) return 'bare'
    if (wt.branch) return wt.branch
    if (wt.head) return `(detached at ${wt.head.slice(0, 8)})`
    return ''
  }

  async createWorktree(): Promise<void> {
    const CREATE_NEW: QuickPickItem = { label: 'Create new branch…', iconId: 'add' }
    const branches = await this._host.listBranches()
    const items: QuickPickItem[] = [CREATE_NEW, ...branches.map((b) => ({ label: b }))]
    const picked = await window.showQuickPick(items, {
      placeHolder: 'Select a branch to create the worktree from',
    })
    if (!picked) return

    let ref = picked.label
    const newBranch = picked === CREATE_NEW
    if (newBranch) {
      const name = await window.showInputBox({ prompt: 'Name of the new branch' })
      if (!name) return
      ref = name.trim()
    }

    // Default location mirrors VSCode: a sibling `<repo>.worktrees/<name>` folder.
    const safeName = ref.replace(/[/\\]/g, '-')
    const defaultPath = join(dirname(this._root), `${basename(this._root)}.worktrees`, safeName)
    const path = await window.showInputBox({
      prompt: 'Worktree location',
      value: defaultPath,
    })
    if (!path) return

    const args = newBranch
      ? ['worktree', 'add', '-b', ref, path.trim()]
      : ['worktree', 'add', path.trim(), ref]
    const ok = await this._host.run(args, 'create worktree', {
      text: 'Creating worktree…',
      kind: 'spinning',
    })
    if (!ok) return

    const worktreePath = path.trim()
    try {
      await stat(join(this._root, '.gitmodules'))
      this._host.beginProgress('Initializing submodules…', 'spinning')
      try {
        const subRes = await gitExec(
          ['submodule', 'update', '--init', '--recursive'],
          worktreePath,
          this._log,
        )
        if (subRes.exitCode !== 0) {
          void window.showWarningMessage(
            `Submodule init failed in new worktree: ${gitErrorText(subRes)}`,
          )
        }
      } finally {
        this._host.endProgress()
      }
    } catch {
      // no .gitmodules, skip
    }

    const open = await window.showInformationMessage(
      `Worktree created at ${worktreePath}.`,
      'Open in New Window',
      'Open',
    )
    if (open === 'Open') {
      await commands.executeCommand('_workbench.openFolder', worktreePath)
    } else if (open === 'Open in New Window') {
      await commands.executeCommand('_workbench.openFolderInNewWindow', worktreePath)
    }
  }

  async openWorktree(newWindow: boolean): Promise<void> {
    const worktrees = (await this._listWorktrees()).filter((wt) => !wt.bare)
    if (worktrees.length <= 1) {
      void window.showInformationMessage('No other worktrees to open.')
      return
    }
    const pick = await window.showQuickPick(
      worktrees.map((wt) => ({
        label: basename(wt.path),
        description: this._worktreeRef(wt),
        detail: wt.path,
      })),
      { placeHolder: newWindow ? 'Open worktree in new window' : 'Open worktree' },
    )
    if (!pick) return
    await commands.executeCommand(
      newWindow ? '_workbench.openFolderInNewWindow' : '_workbench.openFolder',
      pick.detail,
    )
  }

  async deleteWorktree(): Promise<void> {
    const worktrees = (await this._listWorktrees()).filter((wt) => !wt.isMain && !wt.bare)
    if (worktrees.length === 0) {
      void window.showInformationMessage('No worktrees to delete.')
      return
    }
    const pick = await window.showQuickPick(
      worktrees.map((wt) => ({
        label: basename(wt.path),
        description: this._worktreeRef(wt),
        detail: wt.path,
      })),
      { placeHolder: 'Select a worktree to delete' },
    )
    if (!pick) return
    await this.removeWorktreeAt(pick.detail, pick.label)
  }

  /**
   * Remove the worktree at `path`, classifying failures: a folder still held by a
   * running process (an editor window / terminal) can't be forced and needs the
   * holder closed; a dirty-or-locked worktree offers a `--force` retry; a worktree
   * with initialized submodules — which git refuses to remove even with `--force` —
   * has its submodules deinitialized first, then retries. `label` is the human name
   * used in messages. Refreshes the SCM view on success.
   */
  async removeWorktreeAt(path: string, label: string): Promise<void> {
    const res = await gitExec(['worktree', 'remove', path], this._root, this._log)
    if (res.exitCode === 0) {
      await this._finishWorktreeRemoval()
      return
    }

    const stderr = gitErrorText(res)
    const reason = classifyWorktreeRemoveFailure(stderr)

    if (reason === 'busy') {
      this._notifyWorktreeBusy(label, path)
      return
    }

    if (reason === 'submodule') {
      await this._removeWorktreeWithSubmodules(path, label)
      return
    }

    if (reason === 'dirty-or-locked') {
      const force = await window.showWarningMessage(
        `Worktree '${label}' has changes or is locked. Delete anyway?`,
        'Delete',
      )
      if (force === 'Delete') {
        const forced = await gitExec(['worktree', 'remove', '--force', path], this._root, this._log)
        if (forced.exitCode === 0) {
          await this._finishWorktreeRemoval()
          return
        }
        const forcedReason = classifyWorktreeRemoveFailure(gitErrorText(forced))
        if (forcedReason === 'busy') {
          this._notifyWorktreeBusy(label, path)
        } else if (forcedReason === 'submodule') {
          await this._removeWorktreeWithSubmodules(path, label)
        } else {
          await notifyGitFailure('delete worktree', forced)
        }
      }
      return
    }

    await notifyGitFailure('delete worktree', res)
  }

  /**
   * Git refuses to remove a worktree that still has initialized submodules, even
   * with `--force`. Deinitialize them inside the worktree first (this empties the
   * submodule dirs so git no longer treats them as live working trees), then retry
   * the forced removal.
   */
  private async _removeWorktreeWithSubmodules(path: string, label: string): Promise<void> {
    this._host.beginProgress('Deinitializing submodules…', 'spinning')
    try {
      const deinit = await gitExec(['submodule', 'deinit', '--all', '--force'], path, this._log)
      if (deinit.exitCode !== 0) {
        await notifyGitFailure('deinitialize submodules', deinit)
        return
      }
    } finally {
      this._host.endProgress()
    }

    const forced = await gitExec(['worktree', 'remove', '--force', path], this._root, this._log)
    if (forced.exitCode === 0) {
      await this._finishWorktreeRemoval()
      return
    }
    if (classifyWorktreeRemoveFailure(gitErrorText(forced)) === 'busy') {
      this._notifyWorktreeBusy(label, path)
    } else {
      await notifyGitFailure('delete worktree', forced)
    }
  }

  /** Prune stale worktree metadata and refresh the SCM view after a removal. */
  private async _finishWorktreeRemoval(): Promise<void> {
    await gitExec(['worktree', 'prune'], this._root, this._log)
    await this._host.refresh()
  }

  private _notifyWorktreeBusy(label: string, path: string): void {
    void window.showErrorMessage(
      `Can't delete worktree '${label}': its folder is in use. ` +
        `Close any editor windows or terminals opened on ${path} and try again.`,
    )
  }
}
