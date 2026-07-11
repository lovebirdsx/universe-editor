/**
 * A single git repository surfaced through the SCM API. Owns the SourceControl,
 * its staged / working-tree groups, and a debounced filesystem watcher that
 * re-runs `git status` on change. Branch / ahead-behind / in-flight state is
 * exposed as a snapshot plus an `onDidChange` signal; a single shared status-bar
 * controller renders whichever repo is active (see gitStatusBar.ts).
 *
 * All git work goes through `gitExec` (argv arrays, no shell). `refresh` is
 * re-entrant-safe: a change arriving mid-refresh queues exactly one more run.
 *
 * Domain helpers live alongside: status→rows in repositoryDecoration.ts, the fs
 * watcher in repositoryWatcher.ts, worktree operations in repositoryWorktrees.ts,
 * and types / input-command constants / classifiers in repositoryTypes.ts.
 */
import { basename, join, relative } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  commands,
  scm,
  window,
  workspace,
  type Disposable,
  type SourceControl,
  type SourceControlResourceGroup,
} from '@universe-editor/extension-api'
import { localize } from './nls.js'
import { gitExec } from './gitService.js'
import { selectHunkPatch } from './hunkPatch.js'
import { notifyGitFailure } from './gitError.js'
import { parseStatus } from './statusParser.js'
import {
  selectChangedFiles,
  truncateFileDiff,
  buildUntrackedPatch,
  MAX_UNTRACKED_READ_BYTES,
  type ChangeEntry,
  type CommitGenContext,
} from './commitContext.js'
import { stagedStates, workingStates } from './repositoryDecoration.js'
import { RepositoryWatcher } from './repositoryWatcher.js'
import { RepositoryWorktrees } from './repositoryWorktrees.js'
import {
  GIT_COMMIT_INPUT_COMMAND,
  gitCommitActions,
  gitPrimaryInputCommand,
  type FetchOptions,
  type RefreshOptions,
  type RepositoryOptions,
  type RepoStatus,
} from './repositoryTypes.js'

export { parseWorktrees, type WorktreeInfo } from './worktreeParser.js'
export {
  gitPrimaryInputCommand,
  classifyWorktreeRemoveFailure,
  type RepoStatus,
  type WorktreeRemoveFailure,
} from './repositoryTypes.js'

export class Repository {
  private readonly _sc: SourceControl
  private readonly _staged: SourceControlResourceGroup
  private readonly _working: SourceControlResourceGroup
  private readonly _watcher: RepositoryWatcher
  private readonly _worktrees: RepositoryWorktrees
  private readonly _changeListeners = new Set<() => void>()
  private _refreshing = false
  private _queued = false
  private _syncing = false
  private _fetching = false
  /** Count of in-flight progress operations; while > 0 the sync item shows a spinner. */
  private _busy = 0
  private _busyText: { text: string; kind: 'syncing' | 'spinning' } | undefined
  private _disposed = false
  private _stagedCount = 0
  private _workingCount = 0
  private _branch: string | undefined
  private _ahead = 0
  private _behind = 0
  private _autofetchTimer: ReturnType<typeof setInterval> | undefined
  private _autofetchInitial: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly root: string,
    private readonly _log?: (msg: string) => void,
    opts: RepositoryOptions = {},
  ) {
    this._sc = scm.createSourceControl('git', opts.label ?? 'Git', root)
    this._sc.inputBox.placeholder = localize(
      'git.input.placeholder',
      'Message (Ctrl+Enter to commit)',
    )
    this._sc.acceptInputCommand = GIT_COMMIT_INPUT_COMMAND

    this._staged = this._sc.createResourceGroup(
      'index',
      localize('git.group.staged', 'Staged Changes'),
    )
    this._staged.hideWhenEmpty = true
    this._working = this._sc.createResourceGroup(
      'workingTree',
      localize('git.group.changes', 'Changes'),
    )

    this._worktrees = new RepositoryWorktrees({
      root,
      ...(this._log !== undefined ? { log: this._log } : {}),
      beginProgress: (text, kind) => this._beginProgress(text, kind),
      endProgress: () => this._endProgress(),
      refresh: () => this.refresh(),
      listBranches: () => this._listBranches(),
      run: (args, label, progress) => this._run(args, label, progress),
    })

    this._watcher = new RepositoryWatcher(root, () => void this.refresh(), this._log)
    this._watcher.start()
    void this._startAutofetch()
  }

  /** Subscribe to branch / sync / busy state changes for the status bar. */
  onDidChange(listener: () => void): Disposable {
    this._changeListeners.add(listener)
    return { dispose: () => this._changeListeners.delete(listener) }
  }

  private _emitChange(): void {
    for (const l of this._changeListeners) l()
  }

  /** Current branch / ahead-behind / busy snapshot for the status bar. */
  get status(): RepoStatus {
    return {
      branch: this._branch,
      ahead: this._ahead,
      behind: this._behind,
      busy: this._busy > 0 ? this._busyText : undefined,
    }
  }

  async refresh(opts?: RefreshOptions): Promise<void> {
    if (this._refreshing) {
      this._queued = true
      return
    }
    this._refreshing = true
    let shouldFetch = opts?.fetch === true
    try {
      do {
        this._queued = false
        if (shouldFetch) {
          shouldFetch = false
          await this._fetchRemote(opts?.silent !== undefined ? { silent: opts.silent } : undefined)
        }
        await this._doRefresh()
      } while (this._queued && !this._disposed)
    } finally {
      this._refreshing = false
    }
  }

  private async _doRefresh(): Promise<void> {
    const res = await gitExec(
      ['status', '--porcelain=v2', '--branch', '-z', '-uall'],
      this.root,
      this._log,
    )
    if (this._disposed) return
    if (res.exitCode !== 0) {
      this._log?.(`[git] status failed: ${res.stderr.trim()}`)
      return
    }
    const status = parseStatus(res.stdout)
    const mergeEditor = await workspace.getConfiguration('git').get('mergeEditor', true)
    const staged = stagedStates(this.root, status.files, mergeEditor)
    const working = workingStates(this.root, status.files, mergeEditor)
    this._staged.resourceStates = staged
    this._working.resourceStates = working
    this._stagedCount = staged.length
    this._workingCount = working.length
    this._sc.count = staged.length + working.length
    const hasChanges = staged.length + working.length > 0
    this._sc.acceptInputCommand = gitPrimaryInputCommand({
      hasChanges,
      ahead: status.ahead,
      behind: status.behind,
    })
    // With changes, offer the full commit split-button (commit / amend / push /
    // sync). With none, the single primary (push/pull/sync) button suffices, so
    // clear the actions to collapse the dropdown.
    this._sc.acceptInputActions = hasChanges ? gitCommitActions() : undefined
    this._branch = status.branch
    this._ahead = status.ahead
    this._behind = status.behind
    this._emitChange()
  }

  /** Show a spinner on the sync item for the duration of an operation. */
  private _beginProgress(text: string, kind: 'syncing' | 'spinning'): void {
    this._busy++
    this._busyText = { text, kind }
    this._emitChange()
  }

  private _endProgress(): void {
    this._busy = Math.max(0, this._busy - 1)
    if (this._busy === 0) this._busyText = undefined
    this._emitChange()
  }

  get hasStagedChanges(): boolean {
    return this._stagedCount > 0
  }

  get hasChanges(): boolean {
    return this._stagedCount > 0 || this._workingCount > 0
  }

  async stage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    await this._run(['add', '--', ...paths], 'stage')
  }

  /**
   * Stage just the change hunk covering current-document lines [startLine, endLine]
   * (1-based), mirroring VSCode's "Stage Change". Diffs the index against the
   * working tree with zero context so each hunk maps 1:1 to a dirty-diff region,
   * keeps the one overlapping the region, and applies it back with
   * `git apply --cached`. Returns whether anything was staged.
   */
  async stageChange(absPath: string, startLine: number, endLine: number): Promise<boolean> {
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    const diff = await gitExec(['diff', '-U0', '--no-color', '--', rel], this.root, this._log)
    if (diff.exitCode !== 0) {
      await notifyGitFailure('stage change', diff)
      return false
    }
    const patch = selectHunkPatch(diff.stdout, startLine, endLine)
    if (!patch) {
      this._log?.(`stage change: no hunk at lines ${startLine}-${endLine}`)
      return false
    }
    const apply = await gitExec(
      ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'],
      this.root,
      this._log,
      { input: patch },
    )
    if (apply.exitCode !== 0) {
      await notifyGitFailure('stage change', apply)
      return false
    }
    await this.refresh()
    return true
  }

  async stageAll(): Promise<boolean> {
    return this._run(['add', '-A'], 'stage all')
  }

  async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    await this._run(['reset', '-q', 'HEAD', '--', ...paths], 'unstage')
  }

  async unstageAll(): Promise<void> {
    await this._run(['reset', '-q', 'HEAD'], 'unstage all')
  }

  async commit(message: string): Promise<boolean> {
    this._beginProgress(localize('git.progress.committing', 'Committing…'), 'spinning')
    try {
      const res = await gitExec(['commit', '-m', message], this.root, this._log)
      if (res.exitCode !== 0) {
        await notifyGitFailure('commit', res)
        return false
      }
      return true
    } finally {
      this._endProgress()
      await this.refresh()
    }
  }

  async getLastCommitMessage(): Promise<string> {
    const res = await gitExec(['log', '-1', '--format=%B', 'HEAD'], this.root, this._log)
    return res.exitCode === 0 ? res.stdout.trimEnd() : ''
  }

  async commitAmend(message: string): Promise<boolean> {
    this._beginProgress(localize('git.progress.amendingCommit', 'Amending commit…'), 'spinning')
    try {
      const res = await gitExec(['commit', '--amend', '-m', message], this.root, this._log)
      if (res.exitCode !== 0) {
        await notifyGitFailure('commit --amend', res)
        return false
      }
      return true
    } finally {
      this._endProgress()
      await this.refresh()
    }
  }

  async undoLastCommit(): Promise<void> {
    const msgRes = await gitExec(['log', '-1', '--format=%B', 'HEAD'], this.root, this._log)
    const lastMessage = msgRes.exitCode === 0 ? msgRes.stdout.trimEnd() : ''
    await this._run(['reset', '--soft', 'HEAD~1'], 'undo last commit', {
      text: localize('git.progress.undoing', 'Undoing…'),
      kind: 'spinning',
    })
    if (lastMessage) this.commitMessage = lastMessage
  }

  async sync(): Promise<void> {
    if (this._syncing) return
    this._syncing = true
    this._beginProgress(localize('git.progress.syncing', 'Syncing…'), 'syncing')
    try {
      const pull = await gitExec(['pull', '--rebase'], this.root, this._log)
      if (pull.exitCode !== 0) {
        await notifyGitFailure('pull', pull)
        return
      }
      await this._updateSubmodulesIfNeeded()
      const push = await gitExec(['push'], this.root, this._log)
      if (push.exitCode !== 0) {
        await notifyGitFailure('push', push)
      }
    } finally {
      this._syncing = false
      this._endProgress()
      await this.refresh()
    }
  }

  async pull(): Promise<void> {
    const ok = await this._run(['pull'], 'pull', {
      text: localize('git.progress.pulling', 'Pulling…'),
      kind: 'syncing',
    })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async pullRebase(): Promise<void> {
    const ok = await this._run(['pull', '--rebase'], 'pull (rebase)', {
      text: localize('git.progress.pulling', 'Pulling…'),
      kind: 'syncing',
    })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async pullAutostash(): Promise<void> {
    const ok = await this._run(['pull', '--rebase', '--autostash'], 'pull (autostash)', {
      text: localize('git.progress.pulling', 'Pulling…'),
      kind: 'syncing',
    })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async push(): Promise<void> {
    await this._run(['push'], 'push', {
      text: localize('git.progress.pushing', 'Pushing…'),
      kind: 'syncing',
    })
  }

  async pushForce(): Promise<void> {
    const BTN_FORCE_PUSH = localize('git.btn.forcePush', 'Force Push')
    const confirm = await window.showWarningMessage(
      localize(
        'git.push.forceConfirm',
        'Force push to the remote? This overwrites the remote branch history and can discard others’ commits.',
      ),
      BTN_FORCE_PUSH,
    )
    if (confirm !== BTN_FORCE_PUSH) return
    await this._run(['push', '--force-with-lease'], 'push (force)', {
      text: localize('git.progress.pushing', 'Pushing…'),
      kind: 'syncing',
    })
  }

  async pushTo(): Promise<void> {
    const remotes = await this._listRemotes()
    if (remotes.length === 0) {
      void window.showWarningMessage(localize('git.remote.none', 'No remotes configured.'))
      return
    }
    const remote = await window.showQuickPick(remotes, {
      placeHolder: localize('git.pick.remoteToPush', 'Select a remote to push to'),
    })
    if (!remote) return
    await this._run(['push', remote], 'push', {
      text: localize('git.progress.pushing', 'Pushing…'),
      kind: 'syncing',
    })
  }

  async fetch(opts?: FetchOptions): Promise<void> {
    await this._fetchRemote(opts)
    await this.refresh()
  }

  private async _fetchRemote(opts?: FetchOptions): Promise<void> {
    if (this._fetching) return
    this._fetching = true
    this._beginProgress(localize('git.progress.fetching', 'Fetching…'), 'spinning')
    try {
      const args = opts?.prune ? ['fetch', '--prune'] : ['fetch']
      const res = await gitExec(args, this.root, this._log)
      if (res.exitCode !== 0 && opts?.silent !== true) {
        await notifyGitFailure('fetch', res)
      }
    } finally {
      this._fetching = false
      this._endProgress()
    }
  }

  async stashPush(includeUntracked = false): Promise<void> {
    if (!this.hasChanges) {
      void window.showInformationMessage(
        localize('git.stash.noChanges', 'There are no changes to stash.'),
      )
      return
    }
    const args = includeUntracked ? ['stash', 'push', '-u'] : ['stash', 'push']
    await this._run(args, 'stash')
  }

  async stashApply(pop = false): Promise<void> {
    const ref = await this._pickStash(
      pop
        ? localize('git.pick.stashToPop', 'Select a stash to pop')
        : localize('git.pick.stashToApply', 'Select a stash to apply'),
    )
    if (!ref) return
    await this._run(['stash', pop ? 'pop' : 'apply', ref], pop ? 'stash pop' : 'stash apply')
  }

  async stashDrop(): Promise<void> {
    const ref = await this._pickStash(localize('git.pick.stashToDrop', 'Select a stash to drop'))
    if (!ref) return
    await this._run(['stash', 'drop', ref], 'stash drop')
  }

  async merge(): Promise<void> {
    const branch = await this._pickBranch(
      localize('git.pick.branchToMerge', 'Select a branch to merge into the current branch'),
    )
    if (!branch) return
    await this._run(['merge', branch], 'merge')
  }

  async rebase(): Promise<void> {
    const branch = await this._pickBranch(
      localize('git.pick.branchToRebase', 'Select a branch to rebase onto'),
    )
    if (!branch) return
    await this._run(['rebase', branch], 'rebase')
  }

  async renameBranch(): Promise<void> {
    const name = await window.showInputBox({
      prompt: localize('git.input.newBranchName', 'New branch name'),
      ...(this._branch !== undefined ? { value: this._branch } : {}),
    })
    if (!name) return
    await this._run(['branch', '-m', name.trim()], 'rename branch')
  }

  async deleteBranch(): Promise<void> {
    const branches = (await this._listBranches()).filter((b) => b !== this._branch)
    if (branches.length === 0) {
      void window.showInformationMessage(
        localize('git.branch.noOtherToDelete', 'No other branches to delete.'),
      )
      return
    }
    const branch = await window.showQuickPick(branches, {
      placeHolder: localize('git.pick.branchToDelete', 'Select a branch to delete'),
    })
    if (!branch) return
    const res = await gitExec(['branch', '-d', branch], this.root, this._log)
    if (res.exitCode !== 0) {
      // Not fully merged — offer a force delete.
      const BTN_DELETE = localize('git.btn.delete', 'Delete')
      const force = await window.showWarningMessage(
        localize('git.branch.notFullyMerged', "Branch '{0}' is not fully merged. Delete anyway?", {
          0: branch,
        }),
        BTN_DELETE,
      )
      if (force === BTN_DELETE) await this._run(['branch', '-D', branch], 'delete branch')
      return
    }
    await this.refresh()
  }

  async publishBranch(): Promise<void> {
    if (this._branch === undefined) {
      void window.showWarningMessage(localize('git.branch.noneToPublish', 'No branch to publish.'))
      return
    }
    const remotes = await this._listRemotes()
    let remote = remotes[0] ?? 'origin'
    if (remotes.length > 1) {
      const pick = await window.showQuickPick(remotes, {
        placeHolder: localize('git.pick.remote', 'Select a remote'),
      })
      if (!pick) return
      remote = pick
    }
    await this._run(['push', '-u', remote, this._branch], 'publish branch', {
      text: localize('git.progress.publishing', 'Publishing…'),
      kind: 'syncing',
    })
  }

  async addRemote(): Promise<void> {
    const name = await window.showInputBox({
      prompt: localize('git.input.remoteName', 'Remote name (e.g. origin)'),
    })
    if (!name) return
    const url = await window.showInputBox({ prompt: localize('git.input.remoteUrl', 'Remote URL') })
    if (!url) return
    await this._run(['remote', 'add', name.trim(), url.trim()], 'add remote')
  }

  async removeRemote(): Promise<void> {
    const remotes = await this._listRemotes()
    if (remotes.length === 0) {
      void window.showInformationMessage(localize('git.remote.none', 'No remotes configured.'))
      return
    }
    const remote = await window.showQuickPick(remotes, {
      placeHolder: localize('git.pick.remoteToRemove', 'Select a remote to remove'),
    })
    if (!remote) return
    await this._run(['remote', 'remove', remote], 'remove remote')
  }

  async createTag(): Promise<void> {
    const name = await window.showInputBox({ prompt: localize('git.input.tagName', 'Tag name') })
    if (!name) return
    await this._run(['tag', name.trim()], 'create tag')
  }

  async deleteTag(): Promise<void> {
    const tags = await this._listTags()
    if (tags.length === 0) {
      void window.showInformationMessage(localize('git.tag.noneToDelete', 'No tags to delete.'))
      return
    }
    const tag = await window.showQuickPick(tags, {
      placeHolder: localize('git.pick.tagToDelete', 'Select a tag to delete'),
    })
    if (!tag) return
    await this._run(['tag', '-d', tag], 'delete tag')
  }

  async submoduleUpdateInit(): Promise<void> {
    await this._run(['submodule', 'update', '--init', '--recursive'], 'submodule update', {
      text: localize('git.progress.updatingSubmodules', 'Updating submodules…'),
      kind: 'spinning',
    })
  }

  private async _updateSubmodulesIfNeeded(): Promise<void> {
    const cfg = workspace.getConfiguration('git')
    const enabled = await cfg.get('pullSubmoduleUpdate', true)
    if (!enabled) return
    try {
      await stat(join(this.root, '.gitmodules'))
    } catch {
      return
    }
    await this._run(['submodule', 'update', '--init', '--recursive'], 'submodule update', {
      text: localize('git.progress.updatingSubmodules', 'Updating submodules…'),
      kind: 'spinning',
    })
  }

  async submoduleSync(): Promise<void> {
    await this._run(['submodule', 'sync', '--recursive'], 'submodule sync')
  }

  async discard(path: string, untracked: boolean): Promise<void> {
    const args = untracked ? ['clean', '-f', '--', path] : ['checkout', '--', path]
    await this._run(args, 'discard')
  }

  /** Discard every change under a directory — restore tracked files and remove untracked ones. */
  async discardFolder(path: string): Promise<void> {
    // A folder may hold both tracked and untracked changes; `checkout` restores
    // the former (and harmlessly errors when there's nothing tracked to restore,
    // hence no error surfacing here), `clean -fd` removes the latter.
    await gitExec(['checkout', '--', path], this.root, this._log)
    const clean = await gitExec(['clean', '-fd', '--', path], this.root, this._log)
    if (clean.exitCode !== 0) {
      await notifyGitFailure('discard', clean)
    }
    await this.refresh()
  }

  async discardAll(): Promise<void> {
    const BTN_DISCARD_ALL = localize('git.btn.discardAll', 'Discard All Changes')
    const confirm = await window.showWarningMessage(
      localize(
        'git.discard.allConfirm',
        'Discard all changes in the working tree? This cannot be undone.',
      ),
      BTN_DISCARD_ALL,
    )
    if (confirm !== BTN_DISCARD_ALL) return
    const checkout = await gitExec(['checkout', '--', '.'], this.root, this._log)
    if (checkout.exitCode !== 0) {
      await notifyGitFailure('discard', checkout)
    }
    await gitExec(['clean', '-fd'], this.root, this._log)
    await this.refresh()
  }

  async checkout(): Promise<void> {
    const pick = await this._pickBranch(
      localize('git.pick.branchToCheckout', 'Select a branch to checkout'),
    )
    if (!pick) return
    await this._run(['checkout', pick], 'checkout')
  }

  async createBranch(): Promise<void> {
    const name = await window.showInputBox({
      prompt: localize('git.input.newBranchName', 'Name of the new branch'),
    })
    if (!name) return
    await this._run(['checkout', '-b', name.trim()], 'create branch')
  }

  // --- worktrees: delegated to RepositoryWorktrees (constructed with this repo
  //     as its narrow host so it reuses progress + refresh + branch listing). ---

  createWorktree(): Promise<void> {
    return this._worktrees.createWorktree()
  }

  openWorktree(newWindow: boolean): Promise<void> {
    return this._worktrees.openWorktree(newWindow)
  }

  deleteWorktree(): Promise<void> {
    return this._worktrees.deleteWorktree()
  }

  removeWorktreeAt(path: string, label: string): Promise<void> {
    return this._worktrees.removeWorktreeAt(path, label)
  }

  /**
   * Unified diff to commit, mirroring VSCode commit semantics: staged changes
   * when anything is staged (`git diff --cached`), otherwise all tracked
   * working-tree changes (`git diff`). Untracked files are excluded — they carry
   * no diff git can produce without staging.
   */
  async getCommitDiff(): Promise<string> {
    const staged = await gitExec(['diff', '--cached'], this.root, this._log)
    if (staged.exitCode === 0 && staged.stdout.trim()) return staged.stdout
    const working = await gitExec(['diff'], this.root, this._log)
    return working.exitCode === 0 ? working.stdout : ''
  }

  /**
   * Structured context for AI commit-message generation, mirroring VSCode: the
   * staged file set when anything is staged, otherwise working-tree changes plus
   * untracked files (read as synthetic "new file" patches). Each file diff is
   * truncated; recent repository / author commit subjects are included so the
   * model can learn this repo's style.
   */
  async getCommitGenerationContext(): Promise<CommitGenContext> {
    const statusRes = await gitExec(
      ['status', '--porcelain=v2', '--branch', '-z', '-uall'],
      this.root,
      this._log,
    )
    const status = parseStatus(statusRes.exitCode === 0 ? statusRes.stdout : '')
    const entries = selectChangedFiles(status.files)

    const [files, recentCommits, userCommits] = await Promise.all([
      Promise.all(entries.map(async (e) => ({ path: e.path, diff: await this._entryDiff(e) }))),
      this._recentSubjects(),
      this._authorSubjects(),
    ])

    return {
      repoName: basename(this.root),
      branch: status.branch,
      recentCommits,
      userCommits,
      files: files.filter((f) => f.diff.trim().length > 0),
    }
  }

  private async _entryDiff(entry: ChangeEntry): Promise<string> {
    if (entry.source === 'untracked') {
      const abs = join(this.root, entry.path)
      try {
        const info = await stat(abs)
        if (info.size > MAX_UNTRACKED_READ_BYTES) {
          return `[untracked file omitted: ${entry.path} (${info.size} bytes)]`
        }
        return truncateFileDiff(buildUntrackedPatch(entry.path, await readFile(abs, 'utf8')))
      } catch {
        return ''
      }
    }
    const args =
      entry.source === 'index' ? ['diff', '--cached', '--', entry.path] : ['diff', '--', entry.path]
    const res = await gitExec(args, this.root, this._log)
    return res.exitCode === 0 ? truncateFileDiff(res.stdout) : ''
  }

  private async _recentSubjects(): Promise<string[]> {
    const res = await gitExec(['log', '-5', '--format=%s'], this.root, this._log)
    return this._splitSubjects(res.exitCode === 0 ? res.stdout : '')
  }

  private async _authorSubjects(): Promise<string[]> {
    const name = await gitExec(['config', 'user.name'], this.root, this._log)
    const author = name.exitCode === 0 ? name.stdout.trim() : ''
    if (!author) return []
    const res = await gitExec(
      ['log', `--author=${author}`, '-5', '--format=%s'],
      this.root,
      this._log,
    )
    return this._splitSubjects(res.exitCode === 0 ? res.stdout : '')
  }

  private _splitSubjects(raw: string): string[] {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }

  /** The file's content at HEAD, or null when it has no HEAD revision (new / untracked). */
  async getHeadContent(absPath: string): Promise<string | null> {
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    const head = await gitExec(['show', `HEAD:${rel}`], this.root, this._log)
    return head.exitCode === 0 ? head.stdout : null
  }

  /** Open a diff of the file's HEAD revision against its current working-tree content. */
  async openChange(absPath: string, pinned = false, preserveFocus = false): Promise<void> {
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    const head = await gitExec(['show', `HEAD:${rel}`], this.root, this._log)
    const original = head.exitCode === 0 ? head.stdout : '' // new file → no HEAD revision
    let modified = ''
    try {
      modified = await readFile(absPath, 'utf8')
    } catch {
      modified = '' // deleted in the working tree
    }
    await commands.executeCommand('_workbench.openDiff', {
      title: `${basename(absPath)} (Working Tree)`,
      originalUri: pathToFileURL(absPath).href,
      original,
      modified,
      pinned,
      preserveFocus,
      openableUri: pathToFileURL(absPath).href,
    })
  }

  /**
   * Open the 3-way merge editor for a conflicted file. Reads the three git merge
   * stages (`:1:` base, `:2:` ours/HEAD, `:3:` theirs/MERGE_HEAD) plus the
   * working-tree content (markers intact) as the result seed, and labels the two
   * sides from the HEAD / MERGE_HEAD commit subjects.
   */
  async openMergeEditor(absPath: string): Promise<void> {
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    const [base, current, incoming] = await Promise.all([
      this._showStage(`:1:${rel}`),
      this._showStage(`:2:${rel}`),
      this._showStage(`:3:${rel}`),
    ])
    let merged = ''
    try {
      merged = await readFile(absPath, 'utf8')
    } catch {
      merged = ''
    }
    const [currentLabel, incomingLabel] = await Promise.all([
      this._mergeSideLabel('HEAD'),
      this._mergeSideLabel('MERGE_HEAD'),
    ])
    await commands.executeCommand('_workbench.openMergeEditor', {
      path: absPath,
      base,
      current,
      incoming,
      merged,
      currentLabel,
      incomingLabel,
    })
  }

  /** Content of a git object path (e.g. `:2:foo.ts`), or '' when it doesn't exist. */
  private async _showStage(spec: string): Promise<string> {
    const res = await gitExec(['show', spec], this.root, this._log)
    return res.exitCode === 0 ? res.stdout : ''
  }

  /** A `<ref-name>: <subject>` label for a merge side, or '' when unavailable. */
  private async _mergeSideLabel(ref: string): Promise<string> {
    const subject = await gitExec(['log', '-1', '--format=%s', ref], this.root, this._log)
    const name = await gitExec(['rev-parse', '--abbrev-ref', ref], this.root, this._log)
    const shortRef = name.exitCode === 0 ? name.stdout.trim() : ''
    const label = shortRef && shortRef !== 'HEAD' ? shortRef : ref
    const text = subject.exitCode === 0 ? subject.stdout.trim() : ''
    return text ? `${label}: ${text}` : ''
  }

  private async _run(
    args: readonly string[],
    label: string,
    progress?: { text: string; kind: 'syncing' | 'spinning' },
  ): Promise<boolean> {
    if (progress) this._beginProgress(progress.text, progress.kind)
    let ok = false
    try {
      const res = await gitExec(args, this.root, this._log)
      if (res.exitCode !== 0) {
        await notifyGitFailure(label, res)
      } else {
        ok = true
      }
    } finally {
      if (progress) this._endProgress()
      await this.refresh()
    }
    return ok
  }

  private async _listBranches(): Promise<string[]> {
    const res = await gitExec(['branch', '--format=%(refname:short)'], this.root, this._log)
    return res.stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
  }

  private async _listRemotes(): Promise<string[]> {
    const res = await gitExec(['remote'], this.root, this._log)
    return res.stdout
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
  }

  private async _listTags(): Promise<string[]> {
    const res = await gitExec(['tag'], this.root, this._log)
    return res.stdout
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
  }

  private async _pickBranch(placeHolder: string): Promise<string | undefined> {
    const branches = await this._listBranches()
    if (branches.length === 0) {
      void window.showInformationMessage(
        localize('git.branch.noneAvailable', 'No branches available.'),
      )
      return undefined
    }
    return window.showQuickPick(branches, { placeHolder })
  }

  /** Show the stash list as a rich quick pick; resolves to the chosen `stash@{n}` ref. */
  private async _pickStash(placeHolder: string): Promise<string | undefined> {
    const res = await gitExec(['stash', 'list', '--format=%gd%x1f%s'], this.root, this._log)
    const stashes = res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, subject] = line.split('\x1f')
        return { ref: ref ?? '', label: subject ?? ref ?? '' }
      })
      .filter((s) => s.ref)
    if (stashes.length === 0) {
      void window.showInformationMessage(localize('git.stash.none', 'No stashes.'))
      return undefined
    }
    const pick = await window.showQuickPick(
      stashes.map((s) => ({ label: s.label, description: s.ref })),
      { placeHolder },
    )
    return pick?.description
  }

  private async _startAutofetch(): Promise<void> {
    const config = workspace.getConfiguration('git')
    const enabled = await config.get('autofetch', true)
    if (!enabled || this._disposed) return
    const period = await config.get('autofetchPeriod', 180)
    if (this._disposed) return
    const ms = Math.max(30, period) * 1000
    // Kick off an initial fetch shortly after startup, then on a fixed interval.
    this._autofetchInitial = setTimeout(() => void this.fetch({ silent: true }), 3000)
    this._autofetchTimer = setInterval(() => void this.fetch({ silent: true }), ms)
  }

  get commitMessage(): string {
    return this._sc.inputBox.value
  }
  set commitMessage(value: string) {
    this._sc.inputBox.value = value
  }

  basename(path: string): string {
    return basename(path)
  }

  dispose(): void {
    this._disposed = true
    this._watcher.dispose()
    if (this._autofetchInitial) clearTimeout(this._autofetchInitial)
    if (this._autofetchTimer) clearInterval(this._autofetchTimer)
    this._changeListeners.clear()
    this._sc.dispose()
  }
}
