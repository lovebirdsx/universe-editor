/**
 * Watches the whole workspace tree for a `.git` entry appearing (e.g. the user
 * runs `git init` or clones into the folder after the window is open). Mirrors
 * VSCode's `onPossibleGitRepositoryChange`: a recursive fs watch, a path filter
 * that keeps only `.git`-related events, a dedup set, and a debounce so a noisy
 * `git init` (hooks, config, HEAD …) collapses into one candidate callback.
 *
 * Self-contained — owns its watcher, pending set and timer; cleans up on
 * dispose. The `candidate` argument is the directory holding the `.git`, never
 * descended into: a change inside `.git/objects` reports the same repo dir, so
 * the first event already covers it.
 */
import { watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'

export const POSSIBLE_REPO_DEBOUNCE_MS = 500

/** Pure for tests: `sub/dir/.git` → `sub/dir`; anything else → undefined. */
export function repoCandidateFromPath(filename: string): string | undefined {
  const norm = filename.replace(/\\/g, '/')
  if (norm === '.git') return ''
  const idx = norm.indexOf('/.git')
  if (idx === -1) return undefined
  const rest = norm.slice(idx + '/.git'.length)
  if (rest !== '' && !rest.startsWith('/')) return undefined
  return norm.slice(0, idx)
}

export class PossibleRepoWatcher {
  private _watcher: FSWatcher | undefined
  private readonly _pending = new Set<string>()
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(
    private readonly _root: string,
    private readonly _onCandidates: (dirs: readonly string[]) => void,
    private readonly _log?: (msg: string) => void,
  ) {}

  /** Recursive watch isn't available on every platform — log and stay inert. */
  start(): void {
    try {
      this._watcher = watch(this._root, { recursive: true }, (_event, filename) => {
        if (filename == null) return
        const candidate = repoCandidateFromPath(filename.toString())
        if (candidate === undefined) return
        this._pending.add(candidate)
        this._schedule()
      })
    } catch {
      this._log?.('[git] workspace watch unavailable; late repository detection disabled')
    }
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
