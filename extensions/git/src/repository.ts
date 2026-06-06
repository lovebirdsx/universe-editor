/**
 * A single git repository surfaced through the SCM API. Owns the SourceControl,
 * its staged / working-tree groups, the branch status-bar item, and a debounced
 * filesystem watcher that re-runs `git status` on change.
 *
 * All git work goes through `gitExec` (argv arrays, no shell). `refresh` is
 * re-entrant-safe: a change arriving mid-refresh queues exactly one more run.
 */
import { basename, join, relative } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  commands,
  scm,
  window,
  workspace,
  StatusBarAlignment,
  type SourceControl,
  type SourceControlResourceGroup,
  type SourceControlResourceState,
  type StatusBarItem,
} from '@universe-editor/extension-api'
import { gitExec } from './gitService.js'
import { parseStatus, type GitFileStatus } from './statusParser.js'

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
const GIT_SYNC_INPUT_COMMAND = { command: 'git.sync', title: 'Sync' } as const

export function gitPrimaryInputCommand({
  hasChanges,
  ahead,
  behind,
}: {
  readonly hasChanges: boolean
  readonly ahead: number
  readonly behind: number
}) {
  return !hasChanges && (ahead > 0 || behind > 0)
    ? GIT_SYNC_INPUT_COMMAND
    : GIT_COMMIT_INPUT_COMMAND
}

function toResourceState(root: string, path: string, letter: string): SourceControlResourceState {
  const decoration = DECORATIONS[letter] ?? { color: '#cccccc', tooltip: letter }
  return {
    resourceUri: join(root, path),
    contextValue: letter,
    decorations: { tooltip: decoration.tooltip, color: decoration.color },
    command: { command: 'git.openChange', title: 'Open Changes' },
  }
}

function stagedStates(root: string, files: readonly GitFileStatus[]): SourceControlResourceState[] {
  return files
    .filter((f) => f.kind === 'tracked' && f.index !== '.')
    .map((f) => toResourceState(root, f.path, f.index))
}

function workingStates(
  root: string,
  files: readonly GitFileStatus[],
): SourceControlResourceState[] {
  return files
    .filter((f) => f.workingTree !== '.')
    .map((f) => toResourceState(root, f.path, f.workingTree))
}

export class Repository {
  private readonly _sc: SourceControl
  private readonly _staged: SourceControlResourceGroup
  private readonly _working: SourceControlResourceGroup
  private readonly _branchItem: StatusBarItem
  private readonly _syncItem: StatusBarItem
  private readonly _watchers: FSWatcher[] = []
  private _debounce: ReturnType<typeof setTimeout> | undefined
  private _refreshing = false
  private _queued = false
  private _syncing = false
  private _fetching = false
  /** Count of in-flight progress operations; while > 0 the sync item shows a spinner. */
  private _busy = 0
  private _disposed = false
  private _stagedCount = 0
  private _workingCount = 0
  private _branch: string | undefined
  private _autofetchTimer: ReturnType<typeof setInterval> | undefined
  private _autofetchInitial: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly root: string,
    private readonly _log?: (msg: string) => void,
  ) {
    this._sc = scm.createSourceControl('git', 'Git', root)
    this._sc.inputBox.placeholder = 'Message (Ctrl+Enter to commit)'
    this._sc.acceptInputCommand = GIT_COMMIT_INPUT_COMMAND

    this._staged = this._sc.createResourceGroup('index', 'Staged Changes')
    this._staged.hideWhenEmpty = true
    this._working = this._sc.createResourceGroup('workingTree', 'Changes')

    this._branchItem = window.createStatusBarItem(StatusBarAlignment.Left, 100)
    this._branchItem.command = 'git.checkout'
    this._branchItem.tooltip = 'Checkout branch'
    this._branchItem.text = '$(git-branch) …'
    this._branchItem.show()

    this._syncItem = window.createStatusBarItem(StatusBarAlignment.Left, 99)
    this._syncItem.command = 'git.sync'

    this._startWatching()
    void this._startAutofetch()
  }

  async refresh(): Promise<void> {
    if (this._refreshing) {
      this._queued = true
      return
    }
    this._refreshing = true
    try {
      do {
        this._queued = false
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
    const staged = stagedStates(this.root, status.files)
    const working = workingStates(this.root, status.files)
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
    this._branchItem.text = `$(git-branch) ${status.branch ?? 'detached'}`

    // While an operation is showing a spinner, leave the sync item alone.
    if (this._busy === 0) {
      const { ahead, behind } = status
      if (ahead > 0 || behind > 0) {
        const parts: string[] = []
        if (ahead > 0) parts.push(`↑${ahead}`)
        if (behind > 0) parts.push(`↓${behind}`)
        this._syncItem.text = parts.join(' ')
        this._syncItem.tooltip = `${ahead} commit(s) ahead, ${behind} behind — click to sync`
        this._syncItem.showProgress = false
        this._syncItem.show()
      } else {
        this._syncItem.hide()
      }
    }
  }

  /** Show a spinner on the sync item for the duration of an operation. */
  private _beginProgress(text: string, kind: 'syncing' | 'spinning'): void {
    this._busy++
    this._syncItem.text = text
    this._syncItem.tooltip = text
    this._syncItem.showProgress = kind
    this._syncItem.show()
  }

  private _endProgress(): void {
    this._busy = Math.max(0, this._busy - 1)
    if (this._busy === 0) this._syncItem.showProgress = false
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
    await this._run(['reset', '--soft', 'HEAD~1'], 'undo last commit', {
      text: 'Undoing…',
      kind: 'spinning',
    })
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
    await this._run(['pull'], 'pull', { text: 'Pulling…', kind: 'syncing' })
  }

  async pullRebase(): Promise<void> {
    await this._run(['pull', '--rebase'], 'pull (rebase)', { text: 'Pulling…', kind: 'syncing' })
  }

  async pullAutostash(): Promise<void> {
    await this._run(['pull', '--rebase', '--autostash'], 'pull (autostash)', {
      text: 'Pulling…',
      kind: 'syncing',
    })
  }

  async push(): Promise<void> {
    await this._run(['push'], 'push', { text: 'Pushing…', kind: 'syncing' })
  }

  async pushForce(): Promise<void> {
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

  async fetch(opts?: { prune?: boolean; silent?: boolean }): Promise<void> {
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
      await this.refresh()
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

  private async _run(
    args: readonly string[],
    label: string,
    progress?: { text: string; kind: 'syncing' | 'spinning' },
  ): Promise<void> {
    if (progress) this._beginProgress(progress.text, progress.kind)
    try {
      const res = await gitExec(args, this.root, this._log)
      if (res.exitCode !== 0) {
        void window.showErrorMessage(
          `Git ${label} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        )
      }
    } finally {
      if (progress) this._endProgress()
      await this.refresh()
    }
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
    this._branchItem.dispose()
    this._syncItem.dispose()
    this._sc.dispose()
  }
}
