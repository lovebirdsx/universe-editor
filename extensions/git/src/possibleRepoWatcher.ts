/**
 * Watches the workspace root for a `.git` entry appearing at the top level
 * (e.g. the user runs `git init` or clones into the folder after the window is
 * open). Mirrors VSCode's `onPossibleGitRepositoryChange`, narrowed to root
 * level: a non-recursive `fs.watch(root)` only reports entries created directly
 * under the opened folder.
 *
 * Recursive watch is intentionally avoided — a recursive `fs.watch` on a huge
 * tree (pnpm monorepo) exhausts the inotify watch quota, and Node's userland
 * recursive watch throws ENOSPC synchronously inside its event callback where
 * neither `on('error')` nor try/catch can intercept it, crashing the extension
 * host. The RPC filesystem watcher can't take over here because it excludes
 * `.git` (and its subtree) from its events, and the startup scan (`repoDiscovery`)
 * already covers every repo that existed at launch. So the watcher only needs to
 * catch the one case the scan can't: a repo appearing *after* activation in the
 * open folder itself. Deeper late detection (a `git init` inside a nested
 * subfolder) is no longer caught — an accepted tradeoff.
 *
 * Self-contained — owns its watcher, pending set and timer; cleans up on
 * dispose. The `candidate` is always the root dir (''), since the non-recursive
 * watch reports `.git` as a bare filename.
 */
import { statSync, watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'

export const POSSIBLE_REPO_DEBOUNCE_MS = 500

/** A deleted root keeps emitting watch events on Windows; check at most once a
 *  second so the escape stays cheap during the storm. */
const ROOT_EXISTS_CHECK_MS = 1_000

export type RootState = 'present' | 'missing' | 'unknown'

/** Only ENOENT/ENOTDIR prove the root is gone. Other errors (EACCES, a network
 *  drive blip) must not disable late detection for the rest of the session. */
function statRootState(path: string): RootState {
  try {
    statSync(path)
    return 'present'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

/** Pure for tests: a root-level `.git` entry → the root dir (''); else undefined. */
export function repoCandidateFromPath(filename: string): string | undefined {
  const norm = filename.replace(/\\/g, '/')
  return norm === '.git' ? '' : undefined
}

export class PossibleRepoWatcher {
  private _watcher: FSWatcher | undefined
  private readonly _pending = new Set<string>()
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _disposed = false
  private _lastRootCheckAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly _root: string,
    private readonly _onCandidates: (dirs: readonly string[]) => void,
    private readonly _log?: (msg: string) => void,
    private readonly _probeRoot: (path: string) => RootState = statRootState,
  ) {}

  /** Non-recursive watch of the root; on failure log and stay inert. */
  start(): void {
    let watcher: FSWatcher
    try {
      watcher = watch(this._root, (_event, filename) => {
        if (this._disposed) return
        if (this._closeIfRootGone()) return
        if (filename == null) return
        const candidate = repoCandidateFromPath(filename.toString())
        if (candidate === undefined) return
        this._pending.add(candidate)
        this._schedule()
      })
    } catch {
      this._log?.('[git] workspace watch unavailable; late repository detection disabled')
      return
    }
    watcher.on('error', (err) => {
      this._log?.(`[git] workspace watch error; closing: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        // ignore
      }
    })
    this._watcher = watcher
  }

  /** Windows keeps firing events for a deleted watched directory (the callback
   *  then runs until the host quits). Close the watcher once the root is gone
   *  instead of burning a core in it. */
  private _closeIfRootGone(): boolean {
    const now = Date.now()
    const sinceLast = now - this._lastRootCheckAt
    // A backwards clock jump must not suppress the escape until the clock catches up.
    if (sinceLast >= 0 && sinceLast < ROOT_EXISTS_CHECK_MS) return false
    this._lastRootCheckAt = now
    if (this._probeRoot(this._root) !== 'missing') return false
    this._log?.('[git] workspace root disappeared; closing watch')
    this.dispose()
    return true
  }

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = undefined
      if (this._disposed || this._pending.size === 0) return
      const dirs = [...this._pending]
      this._pending.clear()
      this._onCandidates(dirs)
    }, POSSIBLE_REPO_DEBOUNCE_MS)
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) clearTimeout(this._timer)
    this._pending.clear()
    try {
      this._watcher?.close()
    } catch {
      // ignore
    }
  }
}

/** Join helper kept sep-aware so tests can assert relative candidate keys. */
export function joinCandidate(root: string, candidate: string): string {
  return candidate === '' ? root : root + sep + candidate.replace(/\//g, sep)
}
