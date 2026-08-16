/**
 * Filesystem watcher for a repository: a debounced working-tree watch that
 * drives `git status` refreshes, plus a non-recursive `.git` watch so
 * index/HEAD changes still trigger. Self-contained — owns its timers and
 * watchers and cleans them up on dispose. Split out of repository.ts.
 *
 * Working-tree changes go through the extension API
 * `workspace.createFileSystemWatcher(RelativePattern(root, <all-files-glob>))`:
 * the RPC watcher runs out of process with `@parcel/watcher` and pre-excludes
 * node_modules, .git, dist, .turbo and similar subtrees. A recursive
 * `fs.watch(root)` here would exhaust the inotify watch quota on large trees
 * (huge pnpm monorepos), and Node's userland recursive watch throws ENOSPC
 * synchronously inside its event callback — un-interceptable via `on('error')`
 * or try/catch — crashing the extension host. The `.git` directory is excluded
 * by the RPC watcher, so its state is covered by a non-recursive
 * `fs.watch(root/.git)` (index/HEAD are top-level files; non-recursive is
 * enough), with a sync-try/catch + `on('error')` guard so a failure degrades to
 * a log line instead of escaping.
 */
import { join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import {
  RelativePattern,
  type FileSystemWatcher,
  type GlobPattern,
} from '@universe-editor/extension-api'

/** Creates the RPC-backed working-tree watcher; injectable for tests. */
export type CreateFileSystemWatcher = (globPattern: GlobPattern) => FileSystemWatcher

const WATCH_DEBOUNCE_MS = 400

export class RepositoryWatcher {
  private readonly _gitWatchers: FSWatcher[] = []
  private readonly _subscriptions: { dispose(): void }[] = []
  private _workingTreeWatcher: FileSystemWatcher | undefined
  private _debounce: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(
    private readonly _root: string,
    private readonly _onChange: () => void,
    private readonly _createFileSystemWatcher: CreateFileSystemWatcher,
    private readonly _log?: (msg: string) => void,
  ) {}

  start(): void {
    this._watchWorkingTree()
    this._watchGitDir()
  }

  private _watchWorkingTree(): void {
    let watcher: FileSystemWatcher
    try {
      watcher = this._createFileSystemWatcher(new RelativePattern(this._root, '**/*'))
    } catch (err) {
      this._log?.(`[git] working-tree watcher unavailable: ${String(err)}`)
      return
    }
    this._workingTreeWatcher = watcher
    this._subscriptions.push(
      watcher.onDidCreate(() => this._trigger()),
      watcher.onDidChange(() => this._trigger()),
      watcher.onDidDelete(() => this._trigger()),
    )
  }

  private _watchGitDir(): void {
    const target = join(this._root, '.git')
    let watcher: FSWatcher
    try {
      watcher = watch(target, (_event, filename) => {
        if (filename == null) return
        // Within .git only index/HEAD matter; the rest (objects, logs) is noise.
        const name = filename.toString()
        if (name !== 'index' && name !== 'HEAD') return
        this._trigger()
      })
    } catch (err) {
      this._log?.(`[git] .git watch unavailable; index/HEAD refresh disabled: ${String(err)}`)
      return
    }
    watcher.on('error', (err) => {
      this._log?.(`[git] .git watch error; closing: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        // ignore
      }
    })
    this._gitWatchers.push(watcher)
  }

  private _trigger(): void {
    if (this._disposed) return
    if (this._debounce) clearTimeout(this._debounce)
    this._debounce = setTimeout(() => {
      this._debounce = undefined
      if (!this._disposed) this._onChange()
    }, WATCH_DEBOUNCE_MS)
  }

  dispose(): void {
    this._disposed = true
    if (this._debounce) clearTimeout(this._debounce)
    for (const sub of this._subscriptions) sub.dispose()
    this._subscriptions.length = 0
    try {
      this._workingTreeWatcher?.dispose()
    } catch {
      // ignore
    }
    this._workingTreeWatcher = undefined
    for (const w of this._gitWatchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this._gitWatchers.length = 0
  }
}
