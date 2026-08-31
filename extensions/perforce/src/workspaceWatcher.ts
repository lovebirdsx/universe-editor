/**
 * Filesystem watcher for the opened Perforce workspace folder. The server has no
 * push channel and Perforce only knows about files you've explicitly opened, so
 * the "changes to reconcile" group can only reflect disk drift if something
 * watches the disk.
 *
 * Crucially we watch the **opened folder** (`workspace.rootPath`), NOT the p4
 * client root. A p4 client root is the whole workspace mapping (e.g. an entire
 * game project), often many levels above the folder actually open in the editor;
 * watching it is slow. The reconcile *scan scope* is narrowed separately, by the
 * extension (focus folders, or the opened folder) via `client.setReconcileScope`.
 *
 * We must NOT do a recursive `node:fs.watch` over a user directory tree here. On
 * Linux Node implements recursive watch with a per-process inotify instance: a
 * giant monorepo exhausts the kernel `inotify` quota and Node throws `ENOSPC`
 * *synchronously from inside the watch callback*, where no caller can catch it —
 * an uncaughtException that kills the whole extension-host process and sends it
 * into an endless crash/restart loop. Instead we go through
 * `workspace.createFileSystemWatcher` armed with a `RelativePattern` rooted at the
 * opened folder and a recursive `**` glob: the RPC bridge backs it with an
 * out-of-process @parcel/watcher worker (isolated from our inotify quota,
 * self-healing after a crash), and the main side prunes
 * `node_modules` / `.git` / `dist` / `.turbo` at the watcher level so huge trees
 * never generate events. `isNoise` keeps the leftover temp/lock churn out.
 *
 * Unlike git's `git status` (a cheap local read), a full reconcile runs
 * `p4 reconcile -n <scope>` — a server round-trip that walks the whole scope. To
 * keep that off the hot path, the watcher accumulates the *exact* changed paths
 * reported by the create/change/delete events and, after the 400ms debounce, asks
 * the client to reconcile only those paths (`client.refreshReconcilePaths`) — cost
 * is O(changed files), not O(tree size). A one-time full scan is the explicit
 * Clean Refresh; users can turn watching off via `perforce.autoRefresh`.
 */
import {
  RelativePattern,
  workspace,
  type FileSystemWatcher,
  type Uri,
} from '@universe-editor/extension-api'
import type { ClientManager } from './clientManager.js'

const DEBOUNCE_MS = 400

/** Path segments whose changes are never source-control-relevant; skipped so a
 *  busy `.git` or dependency dir doesn't trigger constant reconcile passes. The
 *  main-side watcher already prunes these, but this is a cheap double insurance
 *  for paths that still slip through. */
const IGNORED_SEGMENTS = ['/.git/', '/node_modules/', '/.hg/', '/.svn/']

/** Editor/tool scratch files that churn without being real content changes.
 *  Takes an absolute filesystem path (the watcher event's `uri.fsPath`). */
export function isNoise(absPath: string): boolean {
  const norm = `/${absPath.replace(/\\/g, '/')}/`
  if (IGNORED_SEGMENTS.some((seg) => norm.includes(seg))) return true
  const base = absPath.replace(/\\/g, '/').split('/').pop() ?? ''
  // Common temp/lock artifacts (vim swap, JetBrains, Office locks, trailing ~).
  return base.endsWith('~') || base.endsWith('.swp') || base.startsWith('.~') || base === '4913'
}

/** Builds the extension-API watcher for a folder. Injectable so the controller
 *  can be unit-tested without a live RPC bridge. */
export type WatcherFactory = (folder: string) => FileSystemWatcher

export class WorkspaceWatchController {
  private readonly _watchers: FileSystemWatcher[] = []
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _disposed = false
  private _paused = false
  /** Absolute paths reported changed since the last debounced flush. */
  private readonly _dirty = new Set<string>()

  constructor(
    private readonly _mgr: ClientManager,
    private readonly _log?: (msg: string) => void,
    private readonly _createWatcher: WatcherFactory = (folder) =>
      workspace.createFileSystemWatcher(new RelativePattern(folder, '**/*')),
  ) {}

  /**
   * Stop reacting to disk events until {@link resume}. A `p4 sync` writes every
   * file it brings in, so without this a ten-thousand-file sync would feed ten
   * thousand paths into incremental reconcile — the user's experience is "it
   * finished, then froze for a long time".
   *
   * Pending paths are dropped, not queued: they are the sync's own writes, and
   * the caller runs an explicit refresh once it's done.
   */
  pause(): void {
    this._paused = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = undefined
    this._dirty.clear()
  }

  resume(): void {
    this._paused = false
  }

  /** Start watching `folder` (the opened workspace directory). Events reconcile
   *  only the exact changed paths (O(changes)); the full-scan scope is owned by
   *  the extension, not this watcher. */
  start(enabled: boolean, folder: string | undefined): void {
    if (!enabled || !folder) return

    const client = this._mgr.resolveClient({ resourceUri: folder }) ?? this._mgr.active
    if (!client) {
      this._log?.(`[perforce] file watch: no client owns ${folder}; auto-refresh off`)
      return
    }

    // Incremental: reconcile only the exact changed paths (O(changes)).
    const triggerIncremental = (absPath: string): void => {
      if (this._paused) return
      this._dirty.add(absPath)
      if (this._timer) clearTimeout(this._timer)
      this._timer = setTimeout(() => {
        this._timer = undefined
        const paths = [...this._dirty]
        this._dirty.clear()
        if (!this._disposed && !this._paused) void client.refreshReconcilePaths(paths)
      }, DEBOUNCE_MS)
    }

    const onEvent = (uri: Uri): void => {
      const absPath = uri.fsPath
      if (isNoise(absPath)) return
      triggerIncremental(absPath)
    }

    try {
      const watcher = this._createWatcher(folder)
      this._watchers.push(watcher)
      watcher.onDidCreate(onEvent)
      watcher.onDidChange(onEvent)
      watcher.onDidDelete(onEvent)
      this._log?.(`[perforce] file watch enabled for ${folder}`)
    } catch (err) {
      // Watcher creation is a soft failure: the tree still works, just no
      // auto-refresh. Never let it propagate — activation must not crash the host.
      this._log?.(
        `[perforce] file watcher unavailable for ${folder} (${String(err)}); auto-refresh off`,
      )
    }
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = undefined
    for (const w of this._watchers) {
      try {
        w.dispose()
      } catch {
        // ignore
      }
    }
    this._watchers.length = 0
  }
}
