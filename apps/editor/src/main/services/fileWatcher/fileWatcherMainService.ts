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

function reviveUri(value: UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

function isUnder(fsPath: string, rootFsPath: string): boolean {
  return relativePathUnder(rootFsPath, fsPath, normalizePlatform(platform)) !== null
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
        if (msg.id !== this._watchId) return
        for (const ev of msg.events) {
          this._enqueue(ev.path, PARCEL_EVENT_TYPE[ev.type])
        }
      }),
      _host.onWatchError((msg) => {
        if (msg.id !== this._watchId) return
        this._logger.warn('watcher error', msg.error)
      }),
      _host.onDidRestart(() => this._onDidRestart.fire()),
    ]
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
  private _currentIgnore: string[] = []
  private _pending = new Map<string, FileChangeType>()
  private _remotePending = new Map<string, { resource: URI; type: FileChangeType }>()
  private _flushTimer: NodeJS.Timeout | null = null
  // Coalesced re-subscribe waiting out its quiet window. Waiters resolve when
  // the coalesced _subscribe lands, or when cancelled (teardown / superseded by
  // a different root) — their intent was replaced, which still satisfies watch().
  private _scheduledSubscribe: {
    target: string
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

  async watch(folder: URI, options?: { excludes?: readonly string[] }): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme === REMOTE_SCHEME) {
      await this._watchRemote(uri, options)
      return
    }
    if (uri.scheme !== 'file') {
      throw new Error(`FileWatcher: unsupported scheme: ${uri.scheme}`)
    }
    const target = uri.fsPath
    const ignore = toIgnore(options?.excludes ?? DEFAULT_IGNORE)
    if (this._scheduledSubscribe) {
      return this._scheduleSubscribe(target, ignore)
    }
    if (this._watching && this._rootFsPath === target && sameSet(ignore, this._currentIgnore)) {
      return
    }
    if (!this._watching) {
      // No live subscription to tear down — arm immediately.
      return this._subscribe(target, ignore)
    }
    return this._scheduleSubscribe(target, ignore)
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
    if (!this._rootFsPath) {
      this._currentIgnore = ignore
      return
    }
    // parcel's `ignore` is fixed at subscribe time; re-subscribe the same root.
    // Fire-and-forget: callers notify, they don't wait out the quiet window.
    this._scheduleSubscribe(this._rootFsPath, ignore)
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
      if (this._rootFsPath && isUnder(fsPath, this._rootFsPath)) continue
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
  private readonly _declaredExtraFolders = new Map<string, string>()

  async addOutOfWorkspaceFolder(folder: URI): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme === REMOTE_SCHEME) {
      this._logger.debug(`skip out-of-workspace folder watch for remote URI ${uri.toString()}`)
      return
    }
    if (uri.scheme !== 'file') return
    const fsPath = uri.fsPath
    // The recursive workspace watch already covers these.
    if (this._rootFsPath && isUnder(fsPath, this._rootFsPath)) return
    const key = getPathComparisonKey(fsPath, normalizePlatform(platform))
    if (this._declaredExtraFolders.has(key)) return
    this._declaredExtraFolders.set(key, fsPath)
    this._syncExtraFolderWatchers()
  }

  async removeOutOfWorkspaceFolder(folder: URI): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme !== 'file') return
    const key = getPathComparisonKey(uri.fsPath, normalizePlatform(platform))
    if (this._declaredExtraFolders.delete(key)) {
      this._syncExtraFolderWatchers()
    }
  }

  async clearOutOfWorkspaceFolders(): Promise<void> {
    if (this._declaredExtraFolders.size === 0) return
    this._declaredExtraFolders.clear()
    this._syncExtraFolderWatchers()
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

  private _scheduleSubscribe(target: string, ignore: string[]): Promise<void> {
    const existing = this._scheduledSubscribe
    if (existing && existing.target === target) {
      if (!sameSet(ignore, existing.ignore)) {
        existing.ignore = ignore
        this._slideQuietWindow()
      }
      const waiter = new DeferredPromise<void>()
      existing.waiters.push(waiter)
      return waiter.p
    }
    // A different root supersedes the pending target entirely.
    if (existing) this._cancelScheduledSubscribe()
    const waiter = new DeferredPromise<void>()
    const quietTimer = setTimeout(() => this._flushScheduledSubscribe(), RESUBSCRIBE_QUIET_MS)
    quietTimer.unref()
    const maxTimer = setTimeout(() => this._flushScheduledSubscribe(), RESUBSCRIBE_MAX_WAIT_MS)
    maxTimer.unref()
    this._scheduledSubscribe = { target, ignore, waiters: [waiter], quietTimer, maxTimer }
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
    void this._subscribe(scheduled.target, scheduled.ignore).then(() => {
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

  private async _subscribe(target: string, ignore: string[]): Promise<void> {
    this._resetPending()
    const isFirstWatch = !this._didMarkFirstWatch
    if (isFirstWatch) {
      this._didMarkFirstWatch = true
      mark(PerfMarks.mainWillWatchWorkspace)
    }
    // Adopt the target state up front: concurrent watch()/setExcludes() calls
    // must coalesce against the in-flight target, not the stale subscription.
    this._watching = true
    this._rootFsPath = target
    this._currentIgnore = ignore
    try {
      // Same-id subscribe replaces the previous subscription inside the watcher
      // process, so the old root is torn down there without a separate round trip.
      await this._host.watch(this._watchId, target, ignore)
      this._logger.info(`watch ${target}`)
    } catch (err) {
      // Watcher failures are non-fatal: the tree still works, just no auto-refresh.
      this._watching = false
      this._rootFsPath = null
      this._logger.warn(
        `watch failed ${target}`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    } finally {
      if (isFirstWatch) mark(PerfMarks.mainDidWatchWorkspace)
    }
  }

  private async _teardown(): Promise<void> {
    this._cancelScheduledSubscribe()
    this._resetPending()
    this._watching = false
    const root = this._rootFsPath
    this._rootFsPath = null
    this._currentIgnore = []
    // Unconditionally clear this id on the client: even after a failed watch
    // (where _watching stayed false) the desired entry must go away, or a
    // crash-restart would replay a subscription this window no longer wants.
    try {
      await this._host.unwatch(this._watchId)
    } catch {
      // ignore
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
