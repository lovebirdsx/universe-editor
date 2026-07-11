/**
 * Filesystem watcher for the opened Perforce workspace folder. The server has no
 * push channel and Perforce only knows about files you've explicitly opened, so
 * the "changes to reconcile" group can only reflect disk drift if something
 * watches the disk.
 *
 * Mirrors the git extension's RepositoryWatcher: a debounced recursive `fs.watch`.
 * Any on-disk change — a save from the editor (autosave writes the file), or an
 * edit from an external tool — schedules a refresh with reconcile discovery on,
 * so edited/created/deleted-but-unopened files surface without a manual Clean
 * Refresh.
 *
 * Crucially we watch the **opened folder** (`workspace.rootPath`), NOT the p4
 * client root. A p4 client root is the whole workspace mapping (e.g. an entire
 * game project), often many levels above the folder actually open in the editor;
 * a recursive watch over it is slow and, on Windows, frequently fails outright —
 * degrading to a non-recursive watch that never sees edits in nested folders
 * (the original "my file never appears" bug). Watching the opened folder keeps
 * the recursive watch small and reliable, and we narrow the reconcile scan to
 * that folder too (`<folder>/...` instead of `//...`) so a huge depot isn't
 * walked on every save.
 *
 * Unlike git's `git status` (a cheap local read), a full reconcile runs
 * `p4 reconcile -n <scope>` — a server round-trip that walks the whole scope. To
 * keep that off the hot path, the recursive watch accumulates the *exact* changed
 * paths reported by `fs.watch` and, after the 400ms debounce, asks the client to
 * reconcile only those paths (`client.refreshReconcilePaths`) — cost is
 * O(changed files), not O(tree size). A one-time full scan (edited / created /
 * deleted files discovered across the whole folder) is the explicit Clean Refresh.
 *
 * The non-recursive fallback can't attribute events to a reliable path, so it
 * degrades to a full `refresh({ reconcile: true })`. Users can turn watching off
 * via `perforce.autoRefresh` and fall back to manual Clean Refresh.
 *
 * As a first-party (trusted) extension we run in the host process and may touch
 * `node:fs` directly, exactly like the git extension.
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { ClientManager } from './clientManager.js'

const DEBOUNCE_MS = 400

/** Path segments whose changes are never source-control-relevant; skipped so a
 *  busy `.git` or dependency dir doesn't trigger constant reconcile passes. */
const IGNORED_SEGMENTS = ['/.git/', '/node_modules/', '/.hg/', '/.svn/']

/** Editor/tool scratch files that churn without being real content changes. */
function isNoise(rel: string): boolean {
  const norm = `/${rel.replace(/\\/g, '/')}/`
  if (IGNORED_SEGMENTS.some((seg) => norm.includes(seg))) return true
  const base = rel.replace(/\\/g, '/').split('/').pop() ?? ''
  // Common temp/lock artifacts (vim swap, JetBrains, Office locks, trailing ~).
  return base.endsWith('~') || base.endsWith('.swp') || base.startsWith('.~') || base === '4913'
}

export class WorkspaceWatchController {
  private _enabled = false
  private readonly _watchers: FSWatcher[] = []
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _disposed = false
  /** Absolute paths reported changed since the last debounced flush. */
  private readonly _dirty = new Set<string>()

  constructor(
    private readonly _mgr: ClientManager,
    private readonly _log?: (msg: string) => void,
  ) {}

  /** Start watching `folder` (the opened workspace directory). The full reconcile
   *  scan (Clean Refresh) for its owning client is narrowed to that folder so a
   *  huge depot isn't walked; ordinary saves reconcile only the changed paths. */
  start(enabled: boolean, folder: string | undefined): void {
    this._enabled = enabled
    if (!enabled || !folder) return

    const client = this._mgr.resolveClient({ resourceUri: folder }) ?? this._mgr.active
    if (!client) {
      this._log?.(`[perforce] file watch: no client owns ${folder}; auto-refresh off`)
      return
    }
    client.setReconcileScope(folder)

    // Recursive watch: reconcile only the exact changed paths (O(changes)).
    const triggerIncremental = (filename: string): void => {
      this._dirty.add(join(folder, filename))
      if (this._timer) clearTimeout(this._timer)
      this._timer = setTimeout(() => {
        this._timer = undefined
        const paths = [...this._dirty]
        this._dirty.clear()
        if (!this._disposed) void client.refreshReconcilePaths(paths)
      }, DEBOUNCE_MS)
    }

    // Non-recursive fallback: events carry no reliable path, so fall back to a
    // full reconcile walk of the narrowed scope.
    const triggerFull = (): void => {
      if (this._timer) clearTimeout(this._timer)
      this._timer = setTimeout(() => {
        this._timer = undefined
        if (!this._disposed) void client.refresh({ reconcile: true })
      }, DEBOUNCE_MS)
    }

    try {
      this._watchers.push(
        watch(folder, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const rel = filename.toString()
          if (isNoise(rel)) return
          triggerIncremental(rel)
        }),
      )
      this._log?.(`[perforce] file watch enabled (recursive) for ${folder}`)
    } catch (err) {
      // Recursive watch isn't available on every platform/filesystem; degrade to
      // a non-recursive watch of the folder so at least top-level changes refresh.
      this._log?.(
        `[perforce] recursive watch failed for ${folder} (${String(err)}); falling back to non-recursive`,
      )
      try {
        this._watchers.push(watch(folder, () => triggerFull()))
        this._log?.(`[perforce] file watch enabled (non-recursive) for ${folder}`)
      } catch (err2) {
        this._log?.(
          `[perforce] filesystem watch unavailable for ${folder} (${String(err2)}); auto-refresh off`,
        )
      }
    }
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = undefined
    for (const w of this._watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this._watchers.length = 0
  }
}
