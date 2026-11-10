/**
 * Filesystem watcher for a repository: a working-tree watch that
 * drives `git status` refreshes, plus a non-recursive git-dir watch so
 * index/HEAD/ref changes still trigger. Events are passed straight through to
 * the refresh chain's single debounce (see repository.ts) — no extra debounce here.
 *
 * Working-tree changes go through the extension API
 * `workspace.createFileSystemWatcher(RelativePattern(root, <all-files-glob>))`:
 * the RPC watcher runs out of process with `@parcel/watcher` and pre-excludes
 * node_modules, .git, dist, .turbo and similar subtrees. A recursive
 * `fs.watch(root)` here would exhaust the inotify watch quota on large trees
 * (huge pnpm monorepos), and Node's userland recursive watch throws ENOSPC
 * synchronously inside its event callback — un-interceptable via `on('error')`
 * or try/catch — crashing the extension host. The `.git` directory is excluded
 * by the RPC watcher, so its state is covered by a non-recursive `fs.watch`.
 *
 * A linked worktree's `.git` is a *file*; the real git dir lives under
 * `<main>/.git/worktrees/<name>`. `setGitDirs()` (fed by `rev-parse --git-dir
 * --git-common-dir`) retargets the watcher there. Every successful status also
 * rebuilds a watcher for the upstream ref, since loose refs are replaced by
 * atomic rename (stale handles on Windows) and live under the common dir.
 */
import { join, basename } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import {
  RelativePattern,
  type FileSystemWatcher,
  type GlobPattern,
} from '@universe-editor/extension-api'
import { samePath } from './pathUtil.js'

/** Creates the RPC-backed working-tree watcher; injectable for tests. */
export type CreateFileSystemWatcher = (globPattern: GlobPattern) => FileSystemWatcher

export interface RepositoryWatcherOptions {
  readonly root: string
  readonly onChange: () => void
  readonly createFileSystemWatcher: CreateFileSystemWatcher
  readonly log?: (msg: string) => void
}

/**
 * Whether a first-level git-dir entry should trigger `git status`. Node's
 * non-recursive watch reports each entry's basename, so only the lock file and
 * watchman's cookie are noise; everything else (index, HEAD, COMMIT_EDITMSG,
 * FETCH_HEAD, packed-refs, dir events, ...) means repository state may differ.
 */
export function isRefreshTriggeringGitEntry(filename: string | Buffer | null): boolean {
  if (filename === null) return false
  const name = basename(filename.toString())
  if (name === '' || name === 'index.lock') return false
  return !name.startsWith('.watchman-cookie-')
}

/**
 * Map `git status`'s `branch.upstream` (e.g. `origin/main`, or a bare local
 * branch name) to the ref file under the common dir. The first slash separates
 * remote from branch; branch names may contain further slashes.
 */
export function upstreamRefPath(
  commonDir: string,
  upstream: string | undefined,
): string | undefined {
  const value = upstream?.trim()
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash === -1) return join(commonDir, 'refs', 'heads', value)
  const remote = value.slice(0, slash)
  const name = value.slice(slash + 1)
  if (!remote || !name) return undefined
  return join(commonDir, 'refs', 'remotes', remote, name)
}

export class RepositoryWatcher {
  private readonly _root: string
  private readonly _onChange: () => void
  private readonly _createFileSystemWatcher: CreateFileSystemWatcher
  private readonly _log: ((msg: string) => void) | undefined
  private readonly _subscriptions: { dispose(): void }[] = []
  private _workingTreeWatcher: FileSystemWatcher | undefined
  private _gitDirWatcher: FSWatcher | undefined
  private _upstreamWatcher: FSWatcher | undefined
  private _gitDir: string | undefined
  private _commonDir: string | undefined
  private _upstream: string | undefined
  private _upstreamFailureLoggedFor: string | undefined
  private _gitDirFailureLoggedFor: string | undefined
  private _started = false
  private _disposed = false

  constructor(opts: RepositoryWatcherOptions) {
    this._root = opts.root
    this._onChange = opts.onChange
    this._createFileSystemWatcher = opts.createFileSystemWatcher
    this._log = opts.log
  }

  start(): void {
    if (this._started || this._disposed) return
    this._started = true
    this._watchWorkingTree()
    this._armGitDirWatcher(this._gitDir ?? join(this._root, '.git'))
  }

  /** Retarget the git-dir watch once `rev-parse` resolves the real directory. */
  setGitDirs(dirs: { readonly gitDir: string; readonly commonDir: string }): void {
    if (this._disposed) return
    const commonChanged =
      this._commonDir === undefined || !samePath(this._commonDir, dirs.commonDir)
    this._commonDir = dirs.commonDir

    const sameGitDir = this._gitDir !== undefined && samePath(this._gitDir, dirs.gitDir)
    // Retry a failed/closed watcher on the next status instead of giving up for good.
    const watcherMissing = this._started && this._gitDirWatcher === undefined
    if (!sameGitDir || watcherMissing) {
      this._closeGitDirWatcher()
      if (this._started) this._armGitDirWatcher(dirs.gitDir)
      else this._gitDir = dirs.gitDir
    }

    if (commonChanged && this._upstream !== undefined) this._armUpstreamWatcher()
  }

  /** Track the current branch's upstream ref; rebuilt after every successful status. */
  setUpstream(upstream: string | undefined): void {
    if (this._disposed) return
    const value = upstream?.trim()
    this._upstream = value === '' ? undefined : value
    this._armUpstreamWatcher()
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

  private _armGitDirWatcher(target: string): void {
    this._closeGitDirWatcher()
    if (this._disposed) return
    let watcher: FSWatcher
    try {
      watcher = watch(target, (_event, filename) => {
        if (isRefreshTriggeringGitEntry(filename)) this._trigger()
      })
    } catch (err) {
      if (this._gitDirFailureLoggedFor !== target) {
        this._gitDirFailureLoggedFor = target
        this._log?.(`[git] git-dir watch unavailable for '${target}': ${String(err)}`)
      }
      return
    }
    this._gitDirFailureLoggedFor = undefined
    this._gitDirWatcher = watcher
    this._gitDir = target
    watcher.on('error', (err) => {
      this._log?.(`[git] git-dir watch error for '${target}'; closing: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        // ignore
      }
      if (this._gitDirWatcher === watcher) this._gitDirWatcher = undefined
    })
  }

  private _armUpstreamWatcher(): void {
    this._closeUpstreamWatcher()
    if (this._disposed || this._commonDir === undefined || this._upstream === undefined) return
    const target = upstreamRefPath(this._commonDir, this._upstream)
    if (target === undefined) return
    let watcher: FSWatcher
    try {
      watcher = watch(target, () => this._trigger())
    } catch (err) {
      // A packed ref has no loose file; retry next status but don't spam the log.
      if (this._upstreamFailureLoggedFor !== target) {
        this._upstreamFailureLoggedFor = target
        this._log?.(
          `[git] upstream ref watch unavailable for '${target}', is most likely packed: ${String(err)}`,
        )
      }
      return
    }
    this._upstreamFailureLoggedFor = undefined
    this._upstreamWatcher = watcher
    watcher.on('error', (err) => {
      this._log?.(`[git] upstream ref watch error for '${target}'; closing: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        // ignore
      }
      if (this._upstreamWatcher === watcher) this._upstreamWatcher = undefined
    })
  }

  private _closeGitDirWatcher(): void {
    try {
      this._gitDirWatcher?.close()
    } catch {
      // ignore
    }
    this._gitDirWatcher = undefined
  }

  private _closeUpstreamWatcher(): void {
    try {
      this._upstreamWatcher?.close()
    } catch {
      // ignore
    }
    this._upstreamWatcher = undefined
  }

  private _trigger(): void {
    if (this._disposed) return
    this._onChange()
  }

  dispose(): void {
    this._disposed = true
    for (const sub of this._subscriptions) sub.dispose()
    this._subscriptions.length = 0
    try {
      this._workingTreeWatcher?.dispose()
    } catch {
      // ignore
    }
    this._workingTreeWatcher = undefined
    this._closeGitDirWatcher()
    this._closeUpstreamWatcher()
  }
}
