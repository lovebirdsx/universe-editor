/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process implementation of IFileWatcherService backed by `@parcel/watcher`
 *  (native, prebuilt N-API binding). The renderer drives a single recursive
 *  subscription on the active workspace root.
 *
 *  Excludes (`files.watcherExclude`) are pushed down as parcel's `ignore` option,
 *  so excluded directories (node_modules, .git, …) are pruned at the watcher level
 *  — their children never generate events. This mirrors VSCode and avoids the OS
 *  recursive-watch + per-event JS cost of watching huge trees and filtering after.
 *
 *  The native backend is pinned per platform (see PARCEL_BACKEND). Parcel's
 *  "default" backend on Windows first probes for watchman — shelling out to a
 *  `watchman` subprocess on every (re)subscribe and printing "'watchman' is not
 *  recognized" — before falling back to the windows backend. Naming the backend
 *  skips that probe entirely.
 *--------------------------------------------------------------------------------------------*/

import { platform } from 'node:process'
import { watch as fsWatch } from 'node:fs'
import { dirname } from 'node:path'
import type { FSWatcher } from 'node:fs'
import watcher from '@parcel/watcher'
import type { AsyncSubscription, BackendType, Event as ParcelEvent } from '@parcel/watcher'
import {
  createNamedLogger,
  Emitter,
  normalizePlatform,
  relativePathUnder,
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

const DEBOUNCE_MS = 50

// Pin the parcel backend per platform; see the file header for why "default" is
// avoided. undefined on unknown platforms falls back to parcel's own default.
const PARCEL_BACKEND: BackendType | undefined =
  platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'fs-events'
      : platform === 'linux'
        ? 'inotify'
        : undefined

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

const PARCEL_EVENT_TYPE: Record<ParcelEvent['type'], FileChangeType> = {
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

  constructor(@ILoggerService loggerService?: ILoggerService) {
    this._logger = createNamedLogger(loggerService, { id: 'fileWatcher', name: 'File Watcher' })
  }

  private readonly _onDidChangeFiles = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]> = this._onDidChangeFiles.event

  private _subscription: AsyncSubscription | null = null
  private _rootFsPath: string | null = null
  private _currentIgnore: string[] = []
  private _pending = new Map<string, FileChangeType>()
  private _flushTimer: NodeJS.Timeout | null = null

  // Extra (out-of-workspace) file watches: dirPath → { watcher, files }
  private _extraDirWatchers = new Map<string, { watcher: FSWatcher; files: Set<string> }>()

  async watch(folder: UriComponents, options?: { excludes?: readonly string[] }): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme !== 'file') {
      throw new Error(`FileWatcher: unsupported scheme: ${uri.scheme}`)
    }
    const target = uri.fsPath
    const ignore = toIgnore(options?.excludes ?? DEFAULT_IGNORE)
    if (this._rootFsPath === target && this._subscription && sameSet(ignore, this._currentIgnore)) {
      return
    }
    await this._subscribe(target, ignore)
  }

  async setExcludes(excludes: readonly string[]): Promise<void> {
    const ignore = toIgnore(excludes)
    if (sameSet(ignore, this._currentIgnore)) return
    if (!this._rootFsPath) {
      this._currentIgnore = ignore
      return
    }
    // parcel's `ignore` is fixed at subscribe time; re-subscribe the same root.
    await this._subscribe(this._rootFsPath, ignore)
  }

  async unwatch(): Promise<void> {
    await this._teardown()
  }

  async watchOutOfWorkspace(uris: readonly UriComponents[]): Promise<void> {
    // Build new dirPath → files mapping, skipping files under the workspace root.
    const newDirMap = new Map<string, Set<string>>()
    for (const u of uris) {
      const uri = reviveUri(u)
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
    for (const [dir, files] of newDirMap) {
      const existing = this._extraDirWatchers.get(dir)
      if (existing) {
        existing.files = files
      } else {
        try {
          const w = fsWatch(dir, { recursive: false, persistent: false }, () => {
            const entry = this._extraDirWatchers.get(dir)
            if (!entry) return
            for (const filePath of entry.files) {
              this._enqueue(filePath, 'modified')
            }
          })
          w.on('error', (err) => {
            this._logger.warn(
              `extra watcher error ${dir}`,
              err instanceof Error ? err.message : String(err),
            )
            this._extraDirWatchers.delete(dir)
          })
          this._extraDirWatchers.set(dir, { watcher: w, files })
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
    this._teardownExtraWatchers()
    this._onDidChangeFiles.dispose()
  }

  // For tests: skip the timer and run the pending flush synchronously.
  _flushForTests(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._flush()
  }

  private async _subscribe(target: string, ignore: string[]): Promise<void> {
    await this._teardown()
    try {
      const opts = PARCEL_BACKEND ? { ignore, backend: PARCEL_BACKEND } : { ignore }
      const sub = await watcher.subscribe(target, this._onParcel, opts)
      this._subscription = sub
      this._rootFsPath = target
      this._currentIgnore = ignore
      this._logger.info(`watch ${target}`)
    } catch (err) {
      // Watcher failures are non-fatal: the tree still works, just no auto-refresh.
      this._rootFsPath = null
      this._subscription = null
      this._logger.warn(
        `watch failed ${target}`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  }

  private async _teardown(): Promise<void> {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._pending.clear()
    const sub = this._subscription
    this._subscription = null
    const root = this._rootFsPath
    this._rootFsPath = null
    this._currentIgnore = []
    if (sub) {
      try {
        await sub.unsubscribe()
      } catch {
        // ignore
      }
      if (root) this._logger.info(`unwatch ${root}`)
    }
  }

  private _teardownExtraWatchers(): void {
    for (const [, entry] of this._extraDirWatchers) {
      try {
        entry.watcher.close()
      } catch {
        // ignore
      }
    }
    this._extraDirWatchers.clear()
  }

  private readonly _onParcel = (err: Error | null, events: ParcelEvent[]): void => {
    if (err) {
      this._logger.warn('watcher error', err instanceof Error ? err.message : String(err))
      return
    }
    for (const ev of events) {
      this._enqueue(ev.path, PARCEL_EVENT_TYPE[ev.type])
    }
  }

  private _enqueue(absPath: string, type: FileChangeType): void {
    // Latest event wins for a resource within a single debounce batch.
    this._pending.set(absPath, type)
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      this._flush()
    }, DEBOUNCE_MS)
  }

  private _flush(): void {
    if (this._pending.size === 0) return
    const entries = Array.from(this._pending.entries())
    this._pending.clear()
    const batch: IFileChangeEvent[] = entries.map(([abs, type]) => ({
      type,
      resource: URI.file(abs).toJSON(),
    }))
    if (batch.length > 0) {
      this._logger.debug(`file events count=${batch.length}`)
      this._onDidChangeFiles.fire(batch)
    }
  }
}
