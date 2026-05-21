/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process implementation of IFileWatcherService. Uses Node's recursive
 *  `fs.watch` (Windows + macOS stable; Linux requires Node 20+) and batches
 *  events over a short debounce window. Hard-coded ignore prefixes match the
 *  defaults of VSCode `files.watcherExclude`.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, type FSWatcher, watch } from 'node:fs'
import { join as pathJoin, sep as pathSep } from 'node:path'
import {
  Emitter,
  type Event,
  type IDisposable,
  type IFileChangeEvent,
  type IFileWatcherService,
  NullLogger,
  URI,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'

const DEBOUNCE_MS = 50

const IGNORE_PREFIXES: readonly string[] = [
  'node_modules' + pathSep,
  '.git' + pathSep,
  'dist' + pathSep,
  'out' + pathSep,
  '.turbo' + pathSep,
]

function isIgnored(relPath: string): boolean {
  if (relPath === '') return false
  // Match `node_modules` either as the full segment or as a path prefix.
  for (const prefix of IGNORE_PREFIXES) {
    if (relPath === prefix.slice(0, -1)) return true
    if (relPath.startsWith(prefix)) return true
  }
  return false
}

function reviveUri(value: UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class FileWatcherMainService implements IFileWatcherService, IDisposable {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _logger: ILogger = new NullLogger()) {}

  private readonly _onDidChangeFiles = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]> = this._onDidChangeFiles.event

  private _watcher: FSWatcher | null = null
  private _rootFsPath: string | null = null
  private _pending = new Map<string, 'unknown' | 'deleted'>()
  private _flushTimer: NodeJS.Timeout | null = null

  async watch(folder: UriComponents): Promise<void> {
    const uri = reviveUri(folder)
    if (uri.scheme !== 'file') {
      throw new Error(`FileWatcher: unsupported scheme: ${uri.scheme}`)
    }
    const target = uri.fsPath
    if (this._rootFsPath === target && this._watcher) return
    await this.unwatch()
    try {
      const w = watch(target, { recursive: true }, (_event, filename) => {
        if (filename === null) return
        const rel = typeof filename === 'string' ? filename : String(filename)
        if (isIgnored(rel)) return
        this._enqueue(rel)
      })
      w.on('error', () => {
        // Surface as silent stop; renderer can re-arm by calling watch() again.
        this._logger.warn(`watcher error ${target}`)
        this._teardownWatcher()
      })
      this._watcher = w
      this._rootFsPath = target
      this._logger.info(`watch ${target}`)
    } catch (err) {
      this._rootFsPath = null
      this._logger.warn(
        `watch failed ${target}`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
      throw err
    }
  }

  async unwatch(): Promise<void> {
    this._teardownWatcher()
  }

  dispose(): void {
    this._teardownWatcher()
    this._onDidChangeFiles.dispose()
  }

  // For tests: skip the timer and run the pending flush synchronously.
  _flushForTests(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    void this._flush()
  }

  private _teardownWatcher(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._pending.clear()
    if (this._watcher) {
      const root = this._rootFsPath
      try {
        this._watcher.close()
      } catch {
        // ignore
      }
      this._watcher = null
      if (root) this._logger.info(`unwatch ${root}`)
    }
    this._rootFsPath = null
  }

  private _enqueue(relPath: string): void {
    // Latest event wins for the resource within a single batch; we always
    // re-stat in `_flush`, so 'unknown' is fine.
    if (!this._pending.has(relPath)) this._pending.set(relPath, 'unknown')
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      void this._flush()
    }, DEBOUNCE_MS)
  }

  private async _flush(): Promise<void> {
    if (this._pending.size === 0) return
    const root = this._rootFsPath
    if (!root) {
      this._pending.clear()
      return
    }
    const batch: IFileChangeEvent[] = []
    const entries = Array.from(this._pending.entries())
    this._pending.clear()
    for (const [rel] of entries) {
      const abs = pathJoin(root, rel)
      let type: 'added' | 'deleted' | 'modified'
      try {
        await fs.stat(abs)
        type = 'modified'
      } catch {
        type = 'deleted'
      }
      batch.push({ type, resource: URI.file(abs).toJSON() })
    }
    if (batch.length > 0) {
      this._logger.debug(`file events root=${root} count=${batch.length}`)
      this._onDidChangeFiles.fire(batch)
    }
  }
}
