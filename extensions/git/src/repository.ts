/**
 * A single git repository surfaced through the SCM API. Owns the SourceControl,
 * its staged / working-tree groups, and a debounced filesystem watcher that
 * re-runs `git status` on change. Branch / ahead-behind / in-flight state is
 * exposed as a snapshot plus an `onDidChange` signal; a single shared status-bar
 * controller renders whichever repo is active (see gitStatusBar.ts).
 *
 * All git work goes through `gitExec` (argv arrays, no shell). `refresh` is
 * re-entrant-safe: a change arriving mid-refresh queues exactly one more run.
 */
import { basename, dirname, join, relative } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
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
  type SourceControlResourceState,
} from '@universe-editor/extension-api'
import { gitExec } from './gitService.js'
import { parseStatus, type GitFileStatus } from './statusParser.js'
import {
  selectChangedFiles,
  truncateFileDiff,
  buildUntrackedPatch,
  MAX_UNTRACKED_READ_BYTES,
  type ChangeEntry,
  type CommitGenContext,
} from './commitContext.js'

interface Decoration {
  readonly color: string
  readonly tooltip: string
}

const DECORATIONS: Record<string, Decoration> = {
  M: { color: '#e2c08d', tooltip: 'Modified' },
  A: { color: '#73c991', tooltip: 'Added' },
  D: { color: '#c74e39', tooltip: 'Deleted' },
  R: { color: '#e2c08d', tooltip: 'Renamed' },
  C: { color: '#e2c08d', tooltip: 'Copied' },
  U: { color: '#c74e39', tooltip: 'Conflict' },
  '?': { color: '#73c991', tooltip: 'Untracked' },
}

const GIT_COMMIT_INPUT_COMMAND = { command: 'git.commit', title: 'Commit' } as const
const GIT_COMMIT_DISABLED_INPUT_COMMAND = {
  command: 'git.commit',
  title: 'Commit',
  disabled: true,
} as const
const GIT_PULL_INPUT_COMMAND = { command: 'git.pull', title: 'Pull' } as const
const GIT_PULL_REBASE_INPUT_COMMAND = {
  command: 'git.pullRebase',
  title: 'Pull Rebase',
} as const
const GIT_PUSH_INPUT_COMMAND = { command: 'git.push', title: 'Push' } as const

interface RefreshOptions {
  readonly fetch?: boolean
  readonly silent?: boolean
}

interface FetchOptions {
  readonly prune?: boolean
  readonly silent?: boolean
}

export function gitPrimaryInputCommand({
  hasChanges,
  ahead,
  behind,
}: {
  readonly hasChanges: boolean
  readonly ahead: number
  readonly behind: number
}) {
  if (hasChanges) return GIT_COMMIT_INPUT_COMMAND
  if (ahead > 0 && behind > 0) return GIT_PULL_REBASE_INPUT_COMMAND
  if (ahead > 0) return GIT_PUSH_INPUT_COMMAND
  if (behind > 0) return GIT_PULL_INPUT_COMMAND
  return GIT_COMMIT_DISABLED_INPUT_COMMAND
}

function toResourceState(
  root: string,
  path: string,
  letter: string,
  mergeEditor: boolean,
): SourceControlResourceState {
  const decoration = DECORATIONS[letter] ?? { color: '#cccccc', tooltip: letter }
  // Conflicted (unmerged) files open the 3-way merge editor when enabled;
  // everything else opens a working-tree diff.
  const command =
    letter === 'U' && mergeEditor
      ? { command: 'git.openMergeEditor', title: 'Resolve in Merge Editor' }
      : { command: 'git.openChange', title: 'Open Changes' }
  return {
    resourceUri: join(root, path),
    contextValue: letter,
    decorations: { tooltip: decoration.tooltip, color: decoration.color },
    command,
  }
}

function stagedStates(
  root: string,
  files: readonly GitFileStatus[],
  mergeEditor: boolean,
): SourceControlResourceState[] {
  return files
    .filter((f) => f.kind === 'tracked' && f.index !== '.')
    .map((f) => toResourceState(root, f.path, f.index, mergeEditor))
}

function workingStates(
  root: string,
  files: readonly GitFileStatus[],
  mergeEditor: boolean,
): SourceControlResourceState[] {
  return files
    .filter((f) => f.workingTree !== '.')
    .map((f) => toResourceState(root, f.path, f.workingTree, mergeEditor))
}

interface RepositoryOptions {
  /** SourceControl label shown in the SCM view header (e.g. `Git: <submodule>`). */
  readonly label?: string
}

/** Branch / sync state the shared status-bar controller renders. */
export interface RepoStatus {
  readonly branch: string | undefined
  readonly ahead: number
  readonly behind: number
  /** Non-null while an operation runs: the spinner text + kind to display. */
  readonly busy: { readonly text: string; readonly kind: 'syncing' | 'spinning' } | undefined
}

/** A single linked working tree, as reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
  readonly path: string
  /** Short branch name, or undefined when detached / bare. */
  readonly branch: string | undefined
  /** Abbreviated-or-full HEAD commit, or undefined for a bare worktree. */
  readonly head: string | undefined
  readonly bare: boolean
  readonly detached: boolean
  /** The first entry is always the main working tree. */
  readonly isMain: boolean
}

/**
 * Parse `git worktree list --porcelain` output. Records are blank-line separated;
 * each line is a `key value` pair (or a bare key like `bare` / `detached`). The
 * first record is the main working tree. `branch` carries a full ref
 * (`refs/heads/x`) which we shorten for display.
 */
export function parseWorktrees(stdout: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = []
  let path: string | undefined
  let head: string | undefined
  let branch: string | undefined
  let bare = false
  let detached = false

  const flush = (): void => {
    if (path === undefined) return
    result.push({ path, branch, head, bare, detached, isMain: result.length === 0 })
    path = undefined
    head = undefined
    branch = undefined
    bare = false
    detached = false
  }

  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') {
      flush()
      continue
    }
    const sep = line.indexOf(' ')
    const key = sep === -1 ? line : line.slice(0, sep)
    const value = sep === -1 ? '' : line.slice(sep + 1)
    switch (key) {
      case 'worktree':
        path = value
        break
      case 'HEAD':
        head = value
        break
      case 'branch':
        branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
        break
      case 'bare':
        bare = true
        break
      case 'detached':
        detached = true
        break
    }
  }
  flush()
  return result
}

export type WorktreeRemoveFailure = 'busy' | 'dirty-or-locked' | 'other'

/**
 * Classify why `git worktree remove` failed from its stderr. A worktree whose
 * directory (or a file under it) is still held by a running process — most often
 * an editor window opened on that worktree, or its integrated terminal — fails
 * with EBUSY/EPERM/EINVAL-style messages that `--force` cannot fix; deleting it
 * needs the holding process closed first. A dirty or locked worktree, by
 * contrast, is exactly what `--force` is for.
 */
export function classifyWorktreeRemoveFailure(stderr: string): WorktreeRemoveFailure {
  const msg = stderr.toLowerCase()
  if (
    msg.includes('invalid argument') ||
    msg.includes('permission denied') ||
    msg.includes('access is denied') ||
    msg.includes('being used by another process') ||
    msg.includes('resource busy') ||
    msg.includes('device or resource busy') ||
    msg.includes('operation not permitted')
  ) {
    return 'busy'
  }
  if (
    msg.includes('contains modified or untracked files') ||
    msg.includes('use --force') ||
    msg.includes('is dirty') ||
    msg.includes('locked working tree') ||
    msg.includes('is locked')
  ) {
    return 'dirty-or-locked'
  }
  return 'other'
}

export class Repository {
  private readonly _sc: SourceControl
  private readonly _staged: SourceControlResourceGroup
  private readonly _working: SourceControlResourceGroup
  private readonly _watchers: FSWatcher[] = []
  private readonly _changeListeners = new Set<() => void>()
  private _debounce: ReturnType<typeof setTimeout> | undefined
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
    this._sc.inputBox.placeholder = 'Message (Ctrl+Enter to commit)'
    this._sc.acceptInputCommand = GIT_COMMIT_INPUT_COMMAND

    this._staged = this._sc.createResourceGroup('index', 'Staged Changes')
    this._staged.hideWhenEmpty = true
    this._working = this._sc.createResourceGroup('workingTree', 'Changes')

    this._startWatching()
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
    this._sc.acceptInputCommand = gitPrimaryInputCommand({
      hasChanges: staged.length + working.length > 0,
      ahead: status.ahead,
      behind: status.behind,
    })
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

  async stageAll(): Promise<void> {
    await this._run(['add', '-A'], 'stage all')
  }

  async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    await this._run(['reset', '-q', 'HEAD', '--', ...paths], 'unstage')
  }

  async unstageAll(): Promise<void> {
    await this._run(['reset', '-q', 'HEAD'], 'unstage all')
  }

  async commit(message: string): Promise<boolean> {
    this._beginProgress('Committing…', 'spinning')
    try {
      const res = await gitExec(['commit', '-m', message], this.root, this._log)
      if (res.exitCode !== 0) {
        void window.showErrorMessage(`Git commit failed: ${res.stderr.trim() || res.stdout.trim()}`)
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
      text: 'Undoing…',
      kind: 'spinning',
    })
    if (lastMessage) this.commitMessage = lastMessage
  }

  async sync(): Promise<void> {
    if (this._syncing) return
    this._syncing = true
    this._beginProgress('Syncing…', 'syncing')
    try {
      const pull = await gitExec(['pull', '--rebase'], this.root, this._log)
      if (pull.exitCode !== 0) {
        void window.showErrorMessage(`Git pull failed: ${pull.stderr.trim() || pull.stdout.trim()}`)
        return
      }
      await this._updateSubmodulesIfNeeded()
      const push = await gitExec(['push'], this.root, this._log)
      if (push.exitCode !== 0) {
        void window.showErrorMessage(`Git push failed: ${push.stderr.trim() || push.stdout.trim()}`)
      }
    } finally {
      this._syncing = false
      this._endProgress()
      await this.refresh()
    }
  }

  async pull(): Promise<void> {
    const ok = await this._run(['pull'], 'pull', { text: 'Pulling…', kind: 'syncing' })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async pullRebase(): Promise<void> {
    const ok = await this._run(['pull', '--rebase'], 'pull (rebase)', {
      text: 'Pulling…',
      kind: 'syncing',
    })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async pullAutostash(): Promise<void> {
    const ok = await this._run(['pull', '--rebase', '--autostash'], 'pull (autostash)', {
      text: 'Pulling…',
      kind: 'syncing',
    })
    if (ok) await this._updateSubmodulesIfNeeded()
  }

  async push(): Promise<void> {
    await this._run(['push'], 'push', { text: 'Pushing…', kind: 'syncing' })
  }

  async pushForce(): Promise<void> {
    const confirm = await window.showWarningMessage(
      'Force push to the remote? This overwrites the remote branch history and can discard others’ commits.',
      'Force Push',
    )
    if (confirm !== 'Force Push') return
    await this._run(['push', '--force-with-lease'], 'push (force)', {
      text: 'Pushing…',
      kind: 'syncing',
    })
  }

  async pushTo(): Promise<void> {
    const remotes = await this._listRemotes()
    if (remotes.length === 0) {
      void window.showWarningMessage('No remotes configured.')
      return
    }
    const remote = await window.showQuickPick(remotes, {
      placeHolder: 'Select a remote to push to',
    })
    if (!remote) return
    await this._run(['push', remote], 'push', { text: 'Pushing…', kind: 'syncing' })
  }

  async fetch(opts?: FetchOptions): Promise<void> {
    await this._fetchRemote(opts)
    await this.refresh()
  }

  private async _fetchRemote(opts?: FetchOptions): Promise<void> {
    if (this._fetching) return
    this._fetching = true
    this._beginProgress('Fetching…', 'spinning')
    try {
      const args = opts?.prune ? ['fetch', '--prune'] : ['fetch']
      const res = await gitExec(args, this.root, this._log)
      if (res.exitCode !== 0 && opts?.silent !== true) {
        void window.showErrorMessage(`Git fetch failed: ${res.stderr.trim() || res.stdout.trim()}`)
      }
    } finally {
      this._fetching = false
      this._endProgress()
    }
  }

  async stashPush(includeUntracked = false): Promise<void> {
    if (!this.hasChanges) {
      void window.showInformationMessage('There are no changes to stash.')
      return
    }
    const args = includeUntracked ? ['stash', 'push', '-u'] : ['stash', 'push']
    await this._run(args, 'stash')
  }

  async stashApply(pop = false): Promise<void> {
    const ref = await this._pickStash(pop ? 'Select a stash to pop' : 'Select a stash to apply')
    if (!ref) return
    await this._run(['stash', pop ? 'pop' : 'apply', ref], pop ? 'stash pop' : 'stash apply')
  }

  async stashDrop(): Promise<void> {
    const ref = await this._pickStash('Select a stash to drop')
    if (!ref) return
    await this._run(['stash', 'drop', ref], 'stash drop')
  }

  async merge(): Promise<void> {
    const branch = await this._pickBranch('Select a branch to merge into the current branch')
    if (!branch) return
    await this._run(['merge', branch], 'merge')
  }

  async rebase(): Promise<void> {
    const branch = await this._pickBranch('Select a branch to rebase onto')
    if (!branch) return
    await this._run(['rebase', branch], 'rebase')
  }

  async renameBranch(): Promise<void> {
    const name = await window.showInputBox({
      prompt: 'New branch name',
      ...(this._branch !== undefined ? { value: this._branch } : {}),
    })
    if (!name) return
    await this._run(['branch', '-m', name.trim()], 'rename branch')
  }

  async deleteBranch(): Promise<void> {
    const branches = (await this._listBranches()).filter((b) => b !== this._branch)
    if (branches.length === 0) {
      void window.showInformationMessage('No other branches to delete.')
      return
    }
    const branch = await window.showQuickPick(branches, {
      placeHolder: 'Select a branch to delete',
    })
    if (!branch) return
    const res = await gitExec(['branch', '-d', branch], this.root, this._log)
    if (res.exitCode !== 0) {
      // Not fully merged — offer a force delete.
      const force = await window.showWarningMessage(
        `Branch '${branch}' is not fully merged. Delete anyway?`,
        'Delete',
      )
      if (force === 'Delete') await this._run(['branch', '-D', branch], 'delete branch')
      return
    }
    await this.refresh()
  }

  async publishBranch(): Promise<void> {
    if (this._branch === undefined) {
      void window.showWarningMessage('No branch to publish.')
      return
    }
    const remotes = await this._listRemotes()
    let remote = remotes[0] ?? 'origin'
    if (remotes.length > 1) {
      const pick = await window.showQuickPick(remotes, { placeHolder: 'Select a remote' })
      if (!pick) return
      remote = pick
    }
    await this._run(['push', '-u', remote, this._branch], 'publish branch', {
      text: 'Publishing…',
      kind: 'syncing',
    })
  }

  async addRemote(): Promise<void> {
    const name = await window.showInputBox({ prompt: 'Remote name (e.g. origin)' })
    if (!name) return
    const url = await window.showInputBox({ prompt: 'Remote URL' })
    if (!url) return
    await this._run(['remote', 'add', name.trim(), url.trim()], 'add remote')
  }

  async removeRemote(): Promise<void> {
    const remotes = await this._listRemotes()
    if (remotes.length === 0) {
      void window.showInformationMessage('No remotes configured.')
      return
    }
    const remote = await window.showQuickPick(remotes, { placeHolder: 'Select a remote to remove' })
    if (!remote) return
    await this._run(['remote', 'remove', remote], 'remove remote')
  }

  async createTag(): Promise<void> {
    const name = await window.showInputBox({ prompt: 'Tag name' })
    if (!name) return
    await this._run(['tag', name.trim()], 'create tag')
  }

  async deleteTag(): Promise<void> {
    const tags = await this._listTags()
    if (tags.length === 0) {
      void window.showInformationMessage('No tags to delete.')
      return
    }
    const tag = await window.showQuickPick(tags, { placeHolder: 'Select a tag to delete' })
    if (!tag) return
    await this._run(['tag', '-d', tag], 'delete tag')
  }

  async submoduleUpdateInit(): Promise<void> {
    await this._run(['submodule', 'update', '--init', '--recursive'], 'submodule update', {
      text: 'Updating submodules…',
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
      text: 'Updating submodules…',
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
      void window.showErrorMessage(
        `Git discard failed: ${clean.stderr.trim() || clean.stdout.trim()}`,
      )
    }
    await this.refresh()
  }

  async discardAll(): Promise<void> {
    const confirm = await window.showWarningMessage(
      'Discard all changes in the working tree? This cannot be undone.',
      'Discard All Changes',
    )
    if (confirm !== 'Discard All Changes') return
    const checkout = await gitExec(['checkout', '--', '.'], this.root, this._log)
    if (checkout.exitCode !== 0) {
      void window.showErrorMessage(
        `Git discard failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      )
    }
    await gitExec(['clean', '-fd'], this.root, this._log)
    await this.refresh()
  }

  async checkout(): Promise<void> {
    const pick = await this._pickBranch('Select a branch to checkout')
    if (!pick) return
    await this._run(['checkout', pick], 'checkout')
  }

  async createBranch(): Promise<void> {
    const name = await window.showInputBox({ prompt: 'Name of the new branch' })
    if (!name) return
    await this._run(['checkout', '-b', name.trim()], 'create branch')
  }

  private async _listWorktrees(): Promise<WorktreeInfo[]> {
    const res = await gitExec(['worktree', 'list', '--porcelain'], this.root, this._log)
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
    const CREATE_NEW = '$(plus) Create new branch…'
    const branches = await this._listBranches()
    const pick = await window.showQuickPick([CREATE_NEW, ...branches], {
      placeHolder: 'Select a branch to create the worktree from',
    })
    if (!pick) return

    let ref = pick
    const newBranch = pick === CREATE_NEW
    if (newBranch) {
      const name = await window.showInputBox({ prompt: 'Name of the new branch' })
      if (!name) return
      ref = name.trim()
    }

    // Default location mirrors VSCode: a sibling `<repo>.worktrees/<name>` folder.
    const safeName = ref.replace(/[/\\]/g, '-')
    const defaultPath = join(dirname(this.root), `${basename(this.root)}.worktrees`, safeName)
    const path = await window.showInputBox({
      prompt: 'Worktree location',
      value: defaultPath,
    })
    if (!path) return

    const args = newBranch
      ? ['worktree', 'add', '-b', ref, path.trim()]
      : ['worktree', 'add', path.trim(), ref]
    const ok = await this._run(args, 'create worktree', {
      text: 'Creating worktree…',
      kind: 'spinning',
    })
    if (!ok) return

    const worktreePath = path.trim()
    try {
      await stat(join(this.root, '.gitmodules'))
      this._beginProgress('Initializing submodules…', 'spinning')
      try {
        const subRes = await gitExec(
          ['submodule', 'update', '--init', '--recursive'],
          worktreePath,
          this._log,
        )
        if (subRes.exitCode !== 0) {
          void window.showWarningMessage(
            `Submodule init failed in new worktree: ${subRes.stderr.trim() || subRes.stdout.trim()}`,
          )
        }
      } finally {
        this._endProgress()
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

    const res = await gitExec(['worktree', 'remove', pick.detail], this.root, this._log)
    if (res.exitCode === 0) {
      await gitExec(['worktree', 'prune'], this.root, this._log)
      await this.refresh()
      return
    }

    const stderr = res.stderr.trim() || res.stdout.trim()
    const reason = classifyWorktreeRemoveFailure(stderr)

    if (reason === 'busy') {
      // A directory still held by a running process — typically an editor window
      // open on this worktree or its terminal. `--force` can't help; the holder
      // must be closed first. Don't offer a forced delete that's bound to fail.
      void window.showErrorMessage(
        `Can't delete worktree '${pick.label}': its folder is in use. ` +
          `Close any editor windows or terminals opened on ${pick.detail} and try again.`,
      )
      return
    }

    if (reason === 'dirty-or-locked') {
      const force = await window.showWarningMessage(
        `Worktree '${pick.label}' has changes or is locked. Delete anyway?`,
        'Delete',
      )
      if (force === 'Delete') {
        const forced = await gitExec(
          ['worktree', 'remove', '--force', pick.detail],
          this.root,
          this._log,
        )
        if (forced.exitCode === 0) {
          await gitExec(['worktree', 'prune'], this.root, this._log)
          await this.refresh()
          return
        }
        const forcedErr = forced.stderr.trim() || forced.stdout.trim()
        if (classifyWorktreeRemoveFailure(forcedErr) === 'busy') {
          void window.showErrorMessage(
            `Can't delete worktree '${pick.label}': its folder is in use. ` +
              `Close any editor windows or terminals opened on ${pick.detail} and try again.`,
          )
        } else {
          void window.showErrorMessage(`Git delete worktree failed: ${forcedErr}`)
        }
      }
      return
    }

    void window.showErrorMessage(`Git delete worktree failed: ${stderr}`)
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
        void window.showErrorMessage(
          `Git ${label} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        )
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
      void window.showInformationMessage('No branches available.')
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
      void window.showInformationMessage('No stashes.')
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

  private _startWatching(): void {
    const trigger = (): void => {
      if (this._debounce) clearTimeout(this._debounce)
      this._debounce = setTimeout(() => void this.refresh(), 400)
    }
    try {
      this._watchers.push(
        watch(this.root, { recursive: true }, (_event, filename) => {
          if (filename && this._isIgnored(filename.toString())) return
          trigger()
        }),
      )
    } catch {
      // Recursive watch isn't available on every platform — fall back to the
      // .git directory so at least index/HEAD changes still drive a refresh.
      try {
        this._watchers.push(watch(join(this.root, '.git'), () => trigger()))
      } catch {
        console.error('[git] filesystem watch unavailable; auto-refresh disabled')
        this._log?.('[git] filesystem watch unavailable; auto-refresh disabled')
      }
    }
  }

  /** Within .git, only index/HEAD matter; the rest (objects, logs) is noise. */
  private _isIgnored(filename: string): boolean {
    const norm = filename.replace(/\\/g, '/')
    if (norm !== '.git' && !norm.startsWith('.git/')) return false
    return norm !== '.git/index' && norm !== '.git/HEAD'
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
    if (this._debounce) clearTimeout(this._debounce)
    if (this._autofetchInitial) clearTimeout(this._autofetchInitial)
    if (this._autofetchTimer) clearInterval(this._autofetchTimer)
    for (const w of this._watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this._changeListeners.clear()
    this._sc.dispose()
  }
}
