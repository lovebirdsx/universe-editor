/**
 * Filesystem watcher for a repository: a debounced recursive watch that drives
 * `git status` refreshes, falling back to watching `.git` when recursive watch
 * isn't available. Self-contained — owns its timers and watchers and cleans them
 * up on dispose. Split out of repository.ts.
 */
import { join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'

export class RepositoryWatcher {
  private readonly _watchers: FSWatcher[] = []
  private _debounce: ReturnType<typeof setTimeout> | undefined
  private _disposed = false

  constructor(
    private readonly _root: string,
    private readonly _onChange: () => void,
    private readonly _log?: (msg: string) => void,
  ) {}

  start(): void {
    const trigger = (): void => {
      if (this._debounce) clearTimeout(this._debounce)
      this._debounce = setTimeout(() => {
        if (!this._disposed) this._onChange()
      }, 400)
    }
    try {
      this._watchers.push(
        watch(this._root, { recursive: true }, (_event, filename) => {
          if (filename && this._isIgnored(filename.toString())) return
          trigger()
        }),
      )
    } catch {
      // Recursive watch isn't available on every platform — fall back to the
      // .git directory so at least index/HEAD changes still drive a refresh.
      try {
        this._watchers.push(watch(join(this._root, '.git'), () => trigger()))
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
  }
}
