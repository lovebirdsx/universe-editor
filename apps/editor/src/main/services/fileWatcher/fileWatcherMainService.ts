/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window implementation of IFileWatcherService. The renderer drives a
 *  single recursive subscription on the active workspace root.
 *
 *  The native recursive watcher (@parcel/watcher) does NOT run here: it lives
 *  in a dedicated utility process owned by the app-singleton
 *  WatcherProcessClient (see watcherHost.ts for why — native win32 crashes).
 *  This service keeps the per-window orchestration: root/exclude dedupe,
 *  re-subscribe coalescing, event debounce, and the out-of-workspace extra
 *  watches (plain node:fs non-recursive watches — no native addon, safe
 *  in-process).
 *
 *  Excludes (`files.watcherExclude`) are pushed down as parcel's `ignore`
 *  option, so excluded directories (node_modules, .git, …) are pruned at the
 *  watcher level — their children never generate events. This mirrors VSCode
 *  and avoids the OS recursive-watch + per-event JS cost of watching huge
 *  trees and filtering after.
 *--------------------------------------------------------------------------------------------*/

import { platform } from 'node:process'
import { existsSync, watch as fsWatch } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FSWatcher } from 'node:fs'
import {
  createNamedLogger,
  DeferredPromise,
  Emitter,
  getPathComparisonKey,
  mark,
  normalizePlatform,
  relativePathUnder,
  REMOTE_SCHEME,
  type Event,
  type FileChangeType,
  type IDisposable,
  type IFileChangeEvent,
  type IFileWatcherService,
  type IWatchOptions,
  ILoggerService,
  URI,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import { PerfMarks } from '../../../shared/perf/marks.js'
import { WatcherProcessClient } from '@universe-editor/node-services'
import type { WatcherRawEventType } from '@universe-editor/platform'
import { RemoteWatcherTransport } from '../remote/remoteWatcherTransport.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'
import { remoteFsPathToUri, remotePathFromUri } from '../remote/remoteUri.js'

const DEBOUNCE_MS = 50

// Replacing a live subscription is a native unsubscribe→subscribe on the same
// root; the win32 parcel backend has crashed under fast repeats of that
// sequence (watcher.node ACCESS_VIOLATION during startup exclude hydration).
// Re-subscribes are coalesced through a sliding quiet window (capped) so only
// the settled target reaches native.
const RESUBSCRIBE_QUIET_MS = 500
const RESUBSCRIBE_MAX_WAIT_MS = 2000

// Fallback ignore globs, used only when watch() is called without explicit
// excludes (the renderer normally seeds `files.watcherExclude` from the start).
// Use the `/**` form so toIgnore() also derives the directory form, letting
// parcel prune the subtree (matching a child path needs the `/**` variant).
const DEFAULT_IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.vs/**',
  '**/dist/**',
  '**/out/**',
  '**/.turbo/**',
]

const PARCEL_EVENT_TYPE: Record<WatcherRawEventType, FileChangeType> = {
  create: 'added',
  update: 'modified',
  delete: 'deleted',
}

/**
 * Normalise VSCode-style exclude globs for parcel's `ignore`. A glob like
 * `**\/node_modules/**` only matches files *inside* the directory, so parcel may
 * still recurse into the directory itself. We additionally emit the directory
 * form (`**\/node_modules`) so the whole subtree is pruned. Result is sorted +
 * de-duped for cheap set comparison.
 */
function toIgnore(globs: readonly string[]): string[] {
  const set = new Set<string>()
  for (const g of globs) {
    set.add(g)
    if (g.endsWith('/**')) set.add(g.slice(0, -3))
  }
  return Array.from(set).sort()
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The resolved recursive watch targets, plus the root when only its direct
 * files need covering. Sorted so two resolutions of the same intent compare
 * equal with {@link sameSet}.
 */
interface WatchPlan {
  /** Workspace root, for containment checks by the out-of-workspace watches. */
  readonly root: string
  /** Directories to subscribe recursively. */
  readonly recursive: readonly string[]
  /** Whether the root also needs a non-recursive watch for its own files. */
  readonly rootFilesOnly: boolean
  /**
   * The focus scopes this plan was resolved from, before declared in-workspace
   * folder interests were folded in. Carried on the plan so re-resolving (a
   * later interest, an exclude change) starts from the original request rather
   * than from `recursive`, which would make those interests permanent.
   */
  readonly scopes: readonly string[]
}

/**
 * Collapse nested targets into their shallowest ancestor. Two overlapping
 * recursive subscriptions would report every event under the deeper one twice,
 * and win32 would pin duplicate kernel handles on the same subtree.
 */
function collapseNestedPaths(paths: readonly string[]): string[] {
  const kept: string[] = []
  for (const candidate of [...paths].sort((a, b) => a.length - b.length)) {
    if (kept.some((ancestor) => isUnder(candidate, ancestor))) continue
    kept.push(candidate)
  }
  return kept.sort()
}

function samePlanValue(a: WatchPlan, b: WatchPlan): boolean {
  return (
    a.root === b.root && a.rootFilesOnly === b.rootFilesOnly && sameSet(a.recursive, b.recursive)
  )
}

function reviveUri(value: UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

function isUnder(fsPath: string, rootFsPath: string): boolean {
  return relativePathUnder(rootFsPath, fsPath, normalizePlatform(platform)) !== null
}

function samePath(a: string, b: string): boolean {
  return relativePathUnder(b, a, normalizePlatform(platform)) === ''
}

export class FileWatcherMainService implements IFileWatcherService, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _watchId: number
  private readonly _clientListeners: IDisposable[]

  constructor(
    private readonly _host: WatcherProcessClient,
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService private readonly _connections?: IRemoteConnectionService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'fileWatcher', name: 'File Watcher' })
    this._watchId = _host.allocateId()
    this._clientListeners = [
      _host.onFileEvents((msg) => {
        if (!this._ownsWatchId(msg.id)) return
        for (const ev of msg.events) {
          this._enqueue(ev.path, PARCEL_EVENT_TYPE[ev.type])
        }
      }),
      _host.onWatchError((msg) => {
        if (!this._ownsWatchId(msg.id)) return
        this._logger.warn('watcher error', msg.error)
      }),
      _host.onDidRestart(() => this._onDidRestart.fire()),
    ]
  }

  /**
   * Whether a host message belongs to this window. Focus mode subscribes one id
   * per focused subtree, so the set — not a single id — is the identity.
   */
  private _ownsWatchId(id: number): boolean {
    return id === this._watchId || this._extraWatchIds.has(id)
  }

  private readonly _onDidChangeFiles = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]> = this._onDidChangeFiles.event

  private readonly _onDidRestart = new Emitter<void>()

  // Remote (remote-ssh) watch state: one WatcherProcessClient per authority, its
  // transport tunnelled over the connection (see RemoteWatcherTransport).
  private readonly _remoteWatchers = new Map<
    string,
    { client: WatcherProcessClient; watchId: number; listening: IDisposable[] }
  >()
  private _remoteAuthority: string | null = null
  private _remoteTarget: string | null = null
  private _remoteIgnore: string[] = []

  /** Relayed from the shared watcher process (local host) AND every per-authority
   *  remote watcher client: the host crashed / reconnected and replayed its
   *  subscriptions, so events during the gap are lost — consumers should rescan. */
  get onDidRestart(): Event<void> {
    return this._onDidRestart.event
  }

  private _watching = false
  private _rootFsPath: string | null = null
  /**
   * Bumped by every `_subscribe` and every `_teardown`. `_subscribe` arms one
   * target at a time, so a teardown can land between two of them; the epoch is
   * how the in-flight pass notices it no longer owns the state and releases the
   * ids it armed instead of leaving orphans in the watcher host.
   */
  private _subscribeEpoch = 0
  // The live recursive subscriptions: target fsPath → watcher-host id. The
  // first target reuses `_watchId` so the unfocused single-root case keeps its
  // stable id (and its crash-replay entry) exactly as before.
  private readonly _watchIds = new Map<string, number>()
  private readonly _extraWatchIds = new Set<number>()
  // Non-recursive watch covering the workspace root's own files, armed only in
  // focus mode with focusShowRootFiles on (where no recursive target covers it).
  // `_currentRootFilesOnly` is the *intent* and `_rootFilesWatcher` the realized
  // state: they diverge when fs.watch fails, and plan comparison must follow the
  // intent or every watch() call would see a mismatch and re-subscribe forever.
  private _currentRootFilesOnly = false
  private _rootFilesWatcher: FSWatcher | null = null
  private _rootFilesWatchedPath: string | null = null
  // The focus scopes the workbench last requested, kept apart from the resolved
  // targets in `_watchIds` (which also carry declared in-workspace folder
  // interests). Re-resolving a plan needs the request, not the result: folding
  // the interests back in as scopes would make them permanent.
  private _currentScopes: readonly string[] = []
  private _currentIgnore: string[] = []
  private _pending = new Map<string, FileChangeType>()
  private _remotePending = new Map<string, { resource: URI; type: FileChangeType }>()
  private _flushTimer: NodeJS.Timeout | null = null
  // Coalesced re-subscribe waiting out its quiet window. Waiters resolve when
  // the coalesced _subscribe lands, or when cancelled (teardown / superseded by
  // a different plan) — their intent was replaced, which still satisfies watch().
  //
  // Deliberately ONE window for the whole plan rather than one per target: the
  // plan is resolved as a unit, so a per-target window would let two concurrent
  // changes interleave and land a mix of old and new targets.
  private _scheduledSubscribe: {
    plan: WatchPlan
    ignore: string[]
    waiters: DeferredPromise<void>[]
    quietTimer: NodeJS.Timeout
    maxTimer: NodeJS.Timeout
  } | null = null
  // Perf: mark only the first recursive subscribe (cold startup) so re-subscribes
  // (setExcludes / workspace swap) don't pollute the startup timeline.
  private _didMarkFirstWatch = false

  // Extra (out-of-workspace) file watches: dirPath → { watcher, files }.
  // files maps each watched path to its last observed existence so the
  // dir-level callback can classify added/deleted rather than flattening
  // every event to 'modified'.
  private _extraDirWatchers = new Map<string, { watcher: FSWatcher; files: Map<string, boolean> }>()

  // Extra (out-of-workspace) folder watches, recursive: folderPath → watcher
  private _extraFolderWatchers = new Map<string, FSWatcher>()

  async watch(folder: URI, options?: IWatchOptions): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme === REMOTE_SCHEME) {
      await this._watchRemote(uri, options)
      return
    }
    if (uri.scheme !== 'file') {
      throw new Error(`FileWatcher: unsupported scheme: ${uri.scheme}`)
    }
    const plan = this._resolvePlan(uri, options)
    const ignore = toIgnore(options?.excludes ?? DEFAULT_IGNORE)
    if (this._scheduledSubscribe) {
      return this._scheduleSubscribe(plan, ignore)
    }
    if (this._watching && this._samePlan(plan) && sameSet(ignore, this._currentIgnore)) {
      return
    }
    if (!this._watching) {
      // No live subscription to tear down — arm immediately.
      return this._subscribe(plan, ignore)
    }
    return this._scheduleSubscribe(plan, ignore)
  }

  /**
   * Turn a watch request into the concrete set of directories to subscribe.
   * Scopes outside the root are dropped: they would silently widen the watch
   * beyond the workspace, and `_enqueue` filters events by root anyway.
   */
  private _resolvePlan(root: URI, options?: IWatchOptions): WatchPlan {
    const rootFsPath = root.fsPath
    const scopes: string[] = []
    for (const scope of options?.scopes ?? []) {
      const uri = reviveUri(scope)
      if (uri.scheme !== 'file') continue
      const fsPath = uri.fsPath
      if (!isUnder(fsPath, rootFsPath)) {
        this._logger.warn(`ignoring watch scope outside workspace: ${fsPath}`)
        continue
      }
      scopes.push(fsPath)
    }
    const targets = [...scopes]
    // Declared in-workspace folder interests join the plan as their own targets.
    // Focus narrows what the *workbench* scans, but an extension that asked to
    // watch the whole repo (git's working-tree watcher) must keep receiving
    // events for paths focus hides, or its SCM state goes stale with no way
    // back. Routing them here rather than through _watchExtraFolder is what
    // keeps them out-of-process and exclude-filtered: an in-main recursive
    // fs.watch on the workspace root would be both unfiltered and a repeat of
    // the crash the out-of-process watcher exists to avoid.
    if (scopes.length > 0) {
      for (const fsPath of this._declaredExtraFolders.values()) {
        if (isUnder(fsPath, rootFsPath)) targets.push(fsPath)
      }
    }
    const recursive = collapseNestedPaths(targets)
    // A scope equal to the root, or an empty scope list, means "watch it all" —
    // then the root's own files are already covered recursively.
    const coversRoot = recursive.length === 0 || recursive.some((p) => samePath(p, rootFsPath))
    if (coversRoot) {
      return { root: rootFsPath, recursive: [rootFsPath], rootFilesOnly: false, scopes }
    }
    return {
      root: rootFsPath,
      recursive,
      rootFilesOnly: options?.includeRootFiles === true,
      scopes,
    }
  }

  private _samePlan(plan: WatchPlan): boolean {
    return (
      this._rootFsPath === plan.root &&
      sameSet([...this._watchIds.keys()].sort(), plan.recursive) &&
      this._currentRootFilesOnly === plan.rootFilesOnly
    )
  }

  /** The plan currently live (or pending), for re-subscribes that only change excludes. */
  private _currentPlan(): WatchPlan | null {
    const scheduled = this._scheduledSubscribe
    if (scheduled) return scheduled.plan
    const root = this._rootFsPath
    if (!root) return null
    return {
      root,
      recursive: [...this._watchIds.keys()].sort(),
      rootFilesOnly: this._currentRootFilesOnly,
      scopes: this._currentScopes,
    }
  }

  /** Whether any live recursive target covers `fsPath`. */
  private _isCoveredByWatch(fsPath: string): boolean {
    for (const target of this._watchIds.keys()) {
      if (isUnder(fsPath, target)) return true
    }
    return false
  }

  private async _watchRemote(uri: URI, options?: { excludes?: readonly string[] }): Promise<void> {
    if (!this._connections) {
      throw new Error('FileWatcher: remote connection service not available')
    }
    const authority = uri.authority
    if (!authority) {
      throw new Error('FileWatcher: remote URI has no authority')
    }
    let entry = this._remoteWatchers.get(authority)
    if (!entry) {
      const client = new WatcherProcessClient(
        () => new RemoteWatcherTransport(authority, this._connections!, this._logger),
      )
      const watchId = client.allocateId()
      const listening = [
        client.onFileEvents((msg) => {
          if (msg.id !== watchId) return
          for (const ev of msg.events) {
            this._enqueueRemote(remoteFsPathToUri(ev.path, authority), PARCEL_EVENT_TYPE[ev.type])
          }
        }),
        client.onWatchError((msg) => {
          if (msg.id !== watchId) return
          this._logger.warn(`remote watcher error ${authority}`, msg.error)
        }),
        client.onDidRestart(() => this._onDidRestart.fire()),
      ]
      entry = { client, watchId, listening }
      this._remoteWatchers.set(authority, entry)
    }
    // The server-local absolute path (POSIX on the supported remote targets). Never
    // fsPath the remote-ssh URI itself — the path belongs to the server host.
    const target = remotePathFromUri(uri)
    const ignore = toIgnore(options?.excludes ?? DEFAULT_IGNORE)
    this._remoteAuthority = authority
    this._remoteTarget = target
    this._remoteIgnore = ignore
    try {
      await entry.client.watch(entry.watchId, target, ignore)
      this._logger.info(`watch remote ${authority} ${target}`)
    } catch (err) {
      this._logger.warn(
        `remote watch failed ${authority} ${target}`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }

  private async _teardownRemote(): Promise<void> {
    const authority = this._remoteAuthority
    this._remoteAuthority = null
    this._remoteTarget = null
    this._remoteIgnore = []
    this._remotePending.clear()
    if (authority === null) return
    const entry = this._remoteWatchers.get(authority)
    if (!entry) return
    try {
      await entry.client.unwatch(entry.watchId)
    } catch {
      // ignore
    }
    this._logger.info(`unwatch remote ${authority}`)
  }

  async setExcludes(excludes: readonly string[]): Promise<void> {
    const ignore = toIgnore(excludes)
    if (this._remoteAuthority !== null && this._remoteTarget !== null) {
      this._remoteIgnore = ignore
      const entry = this._remoteWatchers.get(this._remoteAuthority)
      if (entry) await entry.client.watch(entry.watchId, this._remoteTarget, ignore)
      return
    }
    const scheduled = this._scheduledSubscribe
    if (scheduled) {
      if (!sameSet(ignore, scheduled.ignore)) {
        scheduled.ignore = ignore
        this._slideQuietWindow()
      }
      return
    }
    if (sameSet(ignore, this._currentIgnore)) return
    const plan = this._currentPlan()
    if (!plan) {
      this._currentIgnore = ignore
      return
    }
    // parcel's `ignore` is fixed at subscribe time; re-subscribe the same plan.
    // Fire-and-forget: callers notify, they don't wait out the quiet window.
    this._scheduleSubscribe(plan, ignore)
  }

  async unwatch(): Promise<void> {
    await this._teardownRemote()
    await this._teardown()
  }

  async watchOutOfWorkspace(uris: readonly URI[]): Promise<void> {
    // Build new dirPath → files mapping, skipping files under the workspace root.
    const newDirMap = new Map<string, Set<string>>()
    for (const u of uris) {
      const uri = reviveUri(u)
      if (uri.scheme === REMOTE_SCHEME) {
        this._logger.debug(`skip out-of-workspace watch for remote URI ${uri.toString()}`)
        continue
      }
      if (uri.scheme !== 'file') continue
      const fsPath = uri.fsPath
      if (this._isCoveredByWatch(fsPath)) continue
      const dir = dirname(fsPath)
      const files = newDirMap.get(dir) ?? new Set()
      files.add(fsPath)
      newDirMap.set(dir, files)
    }

    // Remove watchers for dirs no longer needed.
    for (const [dir, entry] of this._extraDirWatchers) {
      if (!newDirMap.has(dir)) {
        try {
          entry.watcher.close()
        } catch {
          // ignore
        }
        this._extraDirWatchers.delete(dir)
        this._logger.info(`unwatch extra ${dir}`)
      }
    }

    // Update file sets and add watchers for new dirs.
    for (const [dir, fileSet] of newDirMap) {
      const existing = this._extraDirWatchers.get(dir)
      if (existing) {
        const merged = new Map<string, boolean>()
        for (const f of fileSet) merged.set(f, existing.files.get(f) ?? existsSync(f))
        existing.files = merged
      } else {
        try {
          const w = fsWatch(dir, { recursive: false, persistent: false }, () => {
            const entry = this._extraDirWatchers.get(dir)
            if (!entry) return
            for (const [filePath, knownExists] of entry.files) {
              const exists = existsSync(filePath)
              entry.files.set(filePath, exists)
              // Existence-transition classification: an atomic save replaces
              // the file but it still exists when sampled, staying 'modified'.
              if (exists && knownExists) this._enqueue(filePath, 'modified')
              else if (exists) this._enqueue(filePath, 'added')
              else if (knownExists) this._enqueue(filePath, 'deleted')
            }
          })
          w.on('error', (err) => {
            this._logger.warn(
              `extra watcher error ${dir}`,
              err instanceof Error ? err.message : String(err),
            )
            this._extraDirWatchers.delete(dir)
          })
          const initial = new Map<string, boolean>()
          for (const f of fileSet) initial.set(f, existsSync(f))
          this._extraDirWatchers.set(dir, { watcher: w, files: initial })
          this._logger.info(`watch extra ${dir}`)
        } catch (err) {
          this._logger.warn(
            `watch extra failed ${dir}`,
            err instanceof Error ? (err as Error).message : String(err),
          )
        }
      }
    }
  }

  dispose(): void {
    void this._teardown()
    void this._teardownRemote()
    this._teardownExtraWatchers()
    for (const d of this._clientListeners) d.dispose()
    for (const [, entry] of this._remoteWatchers) {
      for (const d of entry.listening) d.dispose()
      entry.client.dispose()
    }
    this._remoteWatchers.clear()
    this._onDidChangeFiles.dispose()
    this._onDidRestart.dispose()
  }

  // Declared out-of-workspace folder interests (comparison key → fsPath).
  // Callers reference-count; each add/remove re-syncs the armed watch set.
  //
  // Entries that fall *inside* the workspace root are still recorded here, but
  // they are realized as extra targets of the main plan (see _resolvePlan)
  // rather than as in-main fs.watch handles. Under focus they are the only
  // reason a hidden subtree still reports events.
  private readonly _declaredExtraFolders = new Map<string, string>()

  async addOutOfWorkspaceFolder(folder: URI): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme === REMOTE_SCHEME) {
      this._logger.debug(`skip out-of-workspace folder watch for remote URI ${uri.toString()}`)
      return
    }
    if (uri.scheme !== 'file') return
    const fsPath = uri.fsPath
    // Already inside a live recursive target — that subscription delivers it.
    if (this._isCoveredByWatch(fsPath)) return
    const key = getPathComparisonKey(fsPath, normalizePlatform(platform))
    if (this._declaredExtraFolders.has(key)) return
    this._declaredExtraFolders.set(key, fsPath)
    await this._syncDeclaredFolder(fsPath)
  }

  async removeOutOfWorkspaceFolder(folder: URI): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme !== 'file') return
    const fsPath = uri.fsPath
    const key = getPathComparisonKey(fsPath, normalizePlatform(platform))
    if (this._declaredExtraFolders.delete(key)) {
      await this._syncDeclaredFolder(fsPath)
    }
  }

  async clearOutOfWorkspaceFolders(): Promise<void> {
    if (this._declaredExtraFolders.size === 0) return
    const hadInWorkspace = [...this._declaredExtraFolders.values()].some((p) =>
      this._isInWorkspace(p),
    )
    this._declaredExtraFolders.clear()
    this._syncExtraFolderWatchers()
    if (hadInWorkspace) await this._resubscribeCurrentPlan()
  }

  /**
   * Realize one declared-folder change. In-workspace folders belong to the main
   * plan (out-of-process, exclude-filtered); everything else keeps using the
   * in-main fs.watch set, which is bounded to genuinely external directories.
   */
  private async _syncDeclaredFolder(fsPath: string): Promise<void> {
    if (this._isInWorkspace(fsPath)) {
      await this._resubscribeCurrentPlan()
      return
    }
    this._syncExtraFolderWatchers()
  }

  private _isInWorkspace(fsPath: string): boolean {
    const root = this._rootFsPath
    return root !== null && isUnder(fsPath, root)
  }

  /** Re-resolve the live plan so a declared-folder change joins/leaves it. */
  private async _resubscribeCurrentPlan(): Promise<void> {
    const root = this._rootFsPath
    if (!this._watching || root === null) return
    const plan = this._resolvePlan(URI.file(root), {
      scopes: this._currentScopes.map((p) => URI.file(p)),
      includeRootFiles: this._currentRootFilesOnly,
    })
    if (this._samePlan(plan) && this._scheduledSubscribe === null) return
    await this._scheduleSubscribe(plan, this._currentIgnore)
  }

  private _syncExtraFolderWatchers(): void {
    const wanted = new Set<string>()
    for (const fsPath of this._declaredExtraFolders.values()) {
      // Nested folders collapse into the shallowest watch: a recursive parent
      // already delivers events for its subtree, and win32 would otherwise pin
      // duplicate kernel handles on the same subtree.
      let covered = false
      for (const existing of wanted) {
        if (isUnder(fsPath, existing)) {
          covered = true
          break
        }
        if (isUnder(existing, fsPath)) wanted.delete(existing)
      }
      if (!covered) wanted.add(fsPath)
    }

    for (const [dir, w] of this._extraFolderWatchers) {
      if (!wanted.has(dir)) {
        try {
          w.close()
        } catch {
          // ignore
        }
        this._extraFolderWatchers.delete(dir)
        this._logger.info(`unwatch extra folder ${dir}`)
      }
    }

    for (const dir of wanted) {
      if (this._extraFolderWatchers.has(dir)) continue
      this._watchExtraFolder(dir)
    }
  }

  private _watchExtraFolder(dir: string): void {
    if (this._extraFolderWatchers.has(dir)) return
    // On linux, fs.watch on a missing path arms a dead watcher instead of
    // throwing/erroring, so the placeholder below would never engage.
    if (!existsSync(dir)) {
      this._watchExtraFolderPlaceholder(dir)
      return
    }
    // Recursive fs.watch works on every platform this app runs: win32/darwin
    // via native OS support, linux via Node's recursive inotify watches
    // (Node 19.1+; Electron 43 ships a Node well past that).
    try {
      const w = fsWatch(dir, { recursive: true, persistent: false }, (event, filename) => {
        if (!filename) return
        const absPath = join(dir, filename)
        // 'rename' fires for both creation and removal — disambiguate by
        // whether the path exists now.
        if (event === 'change') this._enqueue(absPath, 'modified')
        else this._enqueue(absPath, existsSync(absPath) ? 'added' : 'deleted')
      })
      w.on('error', (err) => {
        this._logger.warn(
          `extra folder watcher error ${dir}`,
          err instanceof Error ? err.message : String(err),
        )
        if (this._extraFolderWatchers.get(dir) === w) this._extraFolderWatchers.delete(dir)
        this._watchExtraFolderPlaceholder(dir)
      })
      this._extraFolderWatchers.set(dir, w)
      this._logger.info(`watch extra folder ${dir}`)
    } catch (err) {
      this._logger.warn(
        `watch extra folder failed ${dir}`,
        err instanceof Error ? (err as Error).message : String(err),
      )
      this._watchExtraFolderPlaceholder(dir)
    }
  }

  /** fs.watch throws on a missing path, so a not-yet-created folder can't be
   *  watched directly: park a non-recursive watch on the parent and arm the
   *  recursive watch once the folder appears. Gives up when the parent is
   *  missing too — a later addOutOfWorkspaceFolder re-arms. */
  private _watchExtraFolderPlaceholder(dir: string): void {
    if (this._extraFolderWatchers.has(dir)) return
    const parent = dirname(dir)
    if (parent === dir || !existsSync(parent)) return
    try {
      const w = fsWatch(parent, { persistent: false }, () => {
        if (this._extraFolderWatchers.get(dir) !== w) return
        // Unrelated churn in the parent must not retire the placeholder —
        // only swap to the real recursive watch once the target appears.
        if (!existsSync(dir)) return
        this._extraFolderWatchers.delete(dir)
        try {
          w.close()
        } catch {
          // ignore
        }
        this._watchExtraFolder(dir)
      })
      w.on('error', () => {
        if (this._extraFolderWatchers.get(dir) === w) this._extraFolderWatchers.delete(dir)
      })
      this._extraFolderWatchers.set(dir, w)
      this._logger.info(`watch extra folder placeholder ${dir} via ${parent}`)
    } catch {
      // The parent vanished between existsSync and fsWatch — give up quietly.
    }
  }

  // For tests: skip the timer and run the pending flush synchronously.
  _flushForTests(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flush()
  }

  // For tests: how many out-of-workspace folder watches are armed.
  get _extraFolderWatcherCount(): number {
    return this._extraFolderWatchers.size
  }

  private _scheduleSubscribe(plan: WatchPlan, ignore: string[]): Promise<void> {
    const existing = this._scheduledSubscribe
    if (existing && samePlanValue(existing.plan, plan)) {
      if (!sameSet(ignore, existing.ignore)) {
        existing.ignore = ignore
        this._slideQuietWindow()
      }
      const waiter = new DeferredPromise<void>()
      existing.waiters.push(waiter)
      return waiter.p
    }
    // A different plan supersedes the pending one entirely.
    if (existing) this._cancelScheduledSubscribe()
    const waiter = new DeferredPromise<void>()
    const quietTimer = setTimeout(() => this._flushScheduledSubscribe(), RESUBSCRIBE_QUIET_MS)
    quietTimer.unref()
    const maxTimer = setTimeout(() => this._flushScheduledSubscribe(), RESUBSCRIBE_MAX_WAIT_MS)
    maxTimer.unref()
    this._scheduledSubscribe = { plan, ignore, waiters: [waiter], quietTimer, maxTimer }
    return waiter.p
  }

  private _slideQuietWindow(): void {
    const scheduled = this._scheduledSubscribe
    if (!scheduled) return
    clearTimeout(scheduled.quietTimer)
    scheduled.quietTimer = setTimeout(() => this._flushScheduledSubscribe(), RESUBSCRIBE_QUIET_MS)
    scheduled.quietTimer.unref()
  }

  private _flushScheduledSubscribe(): void {
    const scheduled = this._scheduledSubscribe
    if (!scheduled) return
    clearTimeout(scheduled.quietTimer)
    clearTimeout(scheduled.maxTimer)
    this._scheduledSubscribe = null
    void this._subscribe(scheduled.plan, scheduled.ignore).then(() => {
      for (const waiter of scheduled.waiters) waiter.complete()
    })
  }

  private _cancelScheduledSubscribe(): void {
    const scheduled = this._scheduledSubscribe
    if (!scheduled) return
    clearTimeout(scheduled.quietTimer)
    clearTimeout(scheduled.maxTimer)
    this._scheduledSubscribe = null
    for (const waiter of scheduled.waiters) waiter.complete()
  }

  private async _subscribe(plan: WatchPlan, ignore: string[]): Promise<void> {
    this._resetPending()
    const epoch = ++this._subscribeEpoch
    const isFirstWatch = !this._didMarkFirstWatch
    if (isFirstWatch) {
      this._didMarkFirstWatch = true
      mark(PerfMarks.mainWillWatchWorkspace)
    }
    // Reuse the id of any target that survives this plan, and hand `_watchId`
    // to the first newcomer — so the unfocused single-root case keeps the exact
    // id (and crash-replay entry) it has always had.
    const nextIds = new Map<string, number>()
    const reused = new Set<number>()
    for (const target of plan.recursive) {
      const existing = this._watchIds.get(target)
      if (existing !== undefined) {
        nextIds.set(target, existing)
        reused.add(existing)
      }
    }
    let primaryFree = !reused.has(this._watchId)
    for (const target of plan.recursive) {
      if (nextIds.has(target)) continue
      if (primaryFree) {
        nextIds.set(target, this._watchId)
        primaryFree = false
      } else {
        nextIds.set(target, this._host.allocateId())
      }
    }

    // Adopt the target state up front: concurrent watch()/setExcludes() calls
    // must coalesce against the in-flight plan, not the stale subscription.
    const keptIds = new Set(nextIds.values())
    const staleIds = [...this._watchIds.values()].filter((id) => !keptIds.has(id))
    this._watching = true
    this._rootFsPath = plan.root
    this._currentIgnore = ignore
    this._currentScopes = plan.scopes
    this._watchIds.clear()
    this._extraWatchIds.clear()
    for (const [target, id] of nextIds) {
      this._watchIds.set(target, id)
      if (id !== this._watchId) this._extraWatchIds.add(id)
    }
    this._syncRootFilesWatcher(plan)

    for (const id of staleIds) {
      await this._unwatchQuietly(id)
    }

    let anyLanded = false
    const armed: number[] = []
    for (const [target, id] of nextIds) {
      // A teardown (or a superseding plan) that landed while the previous target
      // was in flight already owns the state. Arming the rest would leave host
      // subscriptions nothing in this window claims, and since the client records
      // a subscription as desired *before* it can fail, they would also come back
      // on crash replay. Release what this pass armed and stop — the concurrent
      // caller cannot do it for us: its own unwatch sweep may already have run by
      // the time our `watch` reached the host.
      if (epoch !== this._subscribeEpoch) {
        for (const id of armed) await this._unwatchQuietly(id)
        return
      }
      try {
        // Same-id subscribe replaces the previous subscription inside the watcher
        // process, so the old target is torn down there without a separate round trip.
        await this._host.watch(id, target, ignore)
        armed.push(id)
        anyLanded = true
        this._logger.info(`watch ${target}`)
      } catch (err) {
        // Watcher failures are non-fatal: the tree still works, just no auto-refresh.
        // The unwatch clears the id from the client's desired set, which `watch`
        // populated before throwing — otherwise a crash restart would replay a
        // subscription that never worked and that nothing here tracks anymore.
        this._watchIds.delete(target)
        this._extraWatchIds.delete(id)
        await this._unwatchQuietly(id)
        this._logger.warn(
          `watch failed ${target}`,
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        )
      }
    }
    if (epoch !== this._subscribeEpoch) {
      for (const id of armed) await this._unwatchQuietly(id)
      return
    }
    if (!anyLanded) {
      this._watching = false
      this._rootFsPath = null
    }
    if (isFirstWatch) mark(PerfMarks.mainDidWatchWorkspace)
  }

  /** Release a watcher-host id, tolerating a dead/broken host. */
  private async _unwatchQuietly(id: number): Promise<void> {
    try {
      await this._host.unwatch(id)
    } catch {
      // ignore
    }
  }

  /**
   * Arm or retire the non-recursive watch on the workspace root. Needed only in
   * focus mode with root files in scope: no recursive target covers the root
   * then, so a plain node:fs watch (no native addon) fills the gap.
   */
  private _syncRootFilesWatcher(plan: WatchPlan): void {
    this._currentRootFilesOnly = plan.rootFilesOnly
    if (!plan.rootFilesOnly) {
      this._closeRootFilesWatcher()
      return
    }
    if (this._rootFilesWatcher && this._rootFilesWatchedPath === plan.root) return
    this._closeRootFilesWatcher()
    try {
      const w = fsWatch(plan.root, { recursive: false, persistent: false }, (event, filename) => {
        if (!filename) return
        const absPath = join(plan.root, filename)
        if (event === 'change') this._enqueue(absPath, 'modified')
        else this._enqueue(absPath, existsSync(absPath) ? 'added' : 'deleted')
      })
      w.on('error', (err) => {
        this._logger.warn(
          `root files watcher error ${plan.root}`,
          err instanceof Error ? err.message : String(err),
        )
        if (this._rootFilesWatcher === w) this._closeRootFilesWatcher()
      })
      this._rootFilesWatcher = w
      this._rootFilesWatchedPath = plan.root
      this._logger.info(`watch root files ${plan.root}`)
    } catch (err) {
      this._logger.warn(
        `watch root files failed ${plan.root}`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  private _closeRootFilesWatcher(): void {
    const w = this._rootFilesWatcher
    this._rootFilesWatcher = null
    this._rootFilesWatchedPath = null
    if (!w) return
    try {
      w.close()
    } catch {
      // ignore
    }
  }

  private async _teardown(): Promise<void> {
    this._cancelScheduledSubscribe()
    this._resetPending()
    // Invalidates any `_subscribe` still mid-flight, so it releases the ids it
    // armed rather than resurrecting the subscription we are tearing down.
    this._subscribeEpoch++
    this._watching = false
    const root = this._rootFsPath
    this._rootFsPath = null
    this._currentIgnore = []
    this._currentScopes = []
    this._currentRootFilesOnly = false
    this._closeRootFilesWatcher()
    // Unconditionally clear every id this window ever armed, plus `_watchId`
    // even after a failed watch (where it never entered the map): a
    // crash-restart would otherwise replay a subscription we no longer want.
    const ids = new Set<number>([this._watchId, ...this._watchIds.values(), ...this._extraWatchIds])
    this._watchIds.clear()
    this._extraWatchIds.clear()
    for (const id of ids) {
      await this._unwatchQuietly(id)
    }
    if (root) this._logger.info(`unwatch ${root}`)
  }

  private _resetPending(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._pending.clear()
    this._remotePending.clear()
  }

  private _teardownExtraWatchers(): void {
    this._declaredExtraFolders.clear()
    for (const [, entry] of this._extraDirWatchers) {
      try {
        entry.watcher.close()
      } catch {
        // ignore
      }
    }
    this._extraDirWatchers.clear()
    for (const [, w] of this._extraFolderWatchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this._extraFolderWatchers.clear()
  }

  private _enqueue(absPath: string, type: FileChangeType): void {
    // Latest event wins for a resource within a single debounce batch.
    this._pending.set(absPath, type)
    this._armFlush()
  }

  private _enqueueRemote(resource: URI, type: FileChangeType): void {
    this._remotePending.set(resource.toString(), { resource, type })
    this._armFlush()
  }

  private _armFlush(): void {
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this._flush()
    }, DEBOUNCE_MS)
  }

  private _flush(): void {
    if (this._pending.size === 0 && this._remotePending.size === 0) return
    const local = Array.from(this._pending.entries()).map(([abs, type]) => ({
      type,
      resource: URI.file(abs),
    }))
    this._pending.clear()
    const remote = Array.from(this._remotePending.values()).map(({ resource, type }) => ({
      type,
      resource,
    }))
    this._remotePending.clear()
    const batch: IFileChangeEvent[] = [...local, ...remote]
    if (batch.length > 0) {
      this._logger.debug(`file events count=${batch.length}`)
      this._onDidChangeFiles.fire(batch)
    }
  }
}
