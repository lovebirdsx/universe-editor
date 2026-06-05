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
  private _disposed = false

  constructor(readonly root: string) {
    this._sc = scm.createSourceControl('git', 'Git', root)
    this._sc.inputBox.placeholder = 'Message (Ctrl+Enter to commit)'
    this._sc.acceptInputCommand = { command: 'git.commit', title: 'Commit' }

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
    const res = await gitExec(['status', '--porcelain=v2', '--branch', '-z'], this.root)
    if (this._disposed) return
    if (res.exitCode !== 0) {
      console.error(`[git] status failed: ${res.stderr.trim()}`)
      return
    }
    const status = parseStatus(res.stdout)
    const staged = stagedStates(this.root, status.files)
    const working = workingStates(this.root, status.files)
    this._staged.resourceStates = staged
    this._working.resourceStates = working
    this._sc.count = staged.length + working.length
    this._branchItem.text = `$(git-branch) ${status.branch ?? 'detached'}`

    if (!this._syncing) {
      const { ahead, behind } = status
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
    const res = await gitExec(['commit', '-m', message], this.root)
    if (res.exitCode !== 0) {
      void window.showErrorMessage(`Git commit failed: ${res.stderr.trim() || res.stdout.trim()}`)
      return false
    }
    await this.refresh()
    return true
  }

  async sync(): Promise<void> {
    if (this._syncing) return
    this._syncing = true
    this._syncItem.text = 'Syncing…'
    this._syncItem.tooltip = 'Syncing…'
    this._syncItem.show()
    try {
      const pull = await gitExec(['pull', '--rebase'], this.root)
      if (pull.exitCode !== 0) {
        void window.showErrorMessage(`Git pull failed: ${pull.stderr.trim() || pull.stdout.trim()}`)
        return
      }
      const push = await gitExec(['push'], this.root)
      if (push.exitCode !== 0) {
        void window.showErrorMessage(`Git push failed: ${push.stderr.trim() || push.stdout.trim()}`)
      }
    } finally {
      this._syncing = false
      await this.refresh()
    }
  }

  async pull(): Promise<void> {
    await this._run(['pull', '--rebase'], 'pull')
  }

  async push(): Promise<void> {
    await this._run(['push'], 'push')
  }

  async discard(path: string, untracked: boolean): Promise<void> {
    const args = untracked ? ['clean', '-f', '--', path] : ['checkout', '--', path]
    await this._run(args, 'discard')
  }

  async discardAll(): Promise<void> {
    const confirm = await window.showWarningMessage(
      'Discard all changes in the working tree? This cannot be undone.',
      'Discard All Changes',
    )
    if (confirm !== 'Discard All Changes') return
    const checkout = await gitExec(['checkout', '--', '.'], this.root)
    if (checkout.exitCode !== 0) {
      void window.showErrorMessage(
        `Git discard failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      )
    }
    await gitExec(['clean', '-fd'], this.root)
    await this.refresh()
  }

  async checkout(): Promise<void> {
    const res = await gitExec(['branch', '--format=%(refname:short)'], this.root)
    const branches = res.stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
    const pick = await window.showQuickPick(branches, {
      placeHolder: 'Select a branch to checkout',
    })
    if (!pick) return
    await this._run(['checkout', pick], 'checkout')
  }

  async createBranch(): Promise<void> {
    const name = await window.showInputBox({ prompt: 'Name of the new branch' })
    if (!name) return
    await this._run(['checkout', '-b', name.trim()], 'create branch')
  }

  /** Open a diff of the file's HEAD revision against its current working-tree content. */
  async openChange(absPath: string): Promise<void> {
    const rel = relative(this.root, absPath).replace(/\\/g, '/')
    const head = await gitExec(['show', `HEAD:${rel}`], this.root)
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
    })
  }

  private async _run(args: readonly string[], label: string): Promise<void> {
    const res = await gitExec(args, this.root)
    if (res.exitCode !== 0) {
      void window.showErrorMessage(`Git ${label} failed: ${res.stderr.trim() || res.stdout.trim()}`)
    }
    await this.refresh()
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
