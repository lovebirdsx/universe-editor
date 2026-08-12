/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFileEvents — the renderer end of the file-events pair backing
 *  `workspace.createFileSystemWatcher`. It reuses the workbench's existing
 *  recursive workspace watch (IFileWatcherService) instead of arming a native
 *  watcher per extension watcher, and forwards event batches to the host only
 *  while the host declared interest ($subscribeFileEvents → at least one live
 *  extension watcher), so a host with no watchers costs zero RPC traffic.
 *
 *  A watcher anchored outside the workspace (RelativePattern base, or the
 *  literal root of an absolute glob) isn't covered by the workspace watch, so
 *  each such base is reference-counted here and armed via
 *  `watchOutOfWorkspaceFolders`; its events flow through the same
 *  `onDidChangeFiles` → `$acceptFileEvents` pipeline. Bases inside the
 *  workspace need no extra watch — the main side skips them defensively too.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  URI,
  type IFileChangeEvent,
  type IFileWatcherService,
  type ILogger,
  type IUriIdentityService,
  type UriComponents,
} from '@universe-editor/platform'
import type {
  IFileChangeEventDto,
  IExtHostFileEvents,
  IMainThreadFileEvents,
} from '@universe-editor/extensions-common'

/** Batch cap so a mass change (branch switch, build clean) can't flood the
 *  newline-JSON RPC — this repo has an RPC-flood OOM history. */
const MAX_EVENTS_PER_BATCH = 5000

function reviveFileUri(base: UriComponents): URI | undefined {
  const uri = URI.revive(base)
  if (!(uri instanceof URI) || uri.scheme !== 'file') return undefined
  return uri
}

export class MainThreadFileEvents extends Disposable implements IMainThreadFileEvents {
  private _interest = 0
  /** Out-of-workspace base folders, keyed by platform-aware comparison key. */
  private readonly _bases = new Map<string, { uri: URI; count: number }>()
  private _foldersArmed = false

  constructor(
    private readonly _watcher: IFileWatcherService,
    private readonly _extHost: IExtHostFileEvents,
    private readonly _logger: ILogger,
    private readonly _uriIdentity: IUriIdentityService,
  ) {
    super()
    this._register(this._watcher.onDidChangeFiles((events) => this._forward(events)))
  }

  $subscribeFileEvents(base: UriComponents | undefined): Promise<void> {
    this._interest++
    if (base !== undefined) {
      const uri = reviveFileUri(base)
      if (uri) {
        const key = this._uriIdentity.getComparisonKey(uri)
        const entry = this._bases.get(key)
        if (entry) {
          entry.count++
        } else {
          this._bases.set(key, { uri, count: 1 })
          this._syncOutOfWorkspaceWatch()
        }
      }
    }
    return Promise.resolve()
  }

  $unsubscribeFileEvents(base: UriComponents | undefined): Promise<void> {
    this._interest = Math.max(0, this._interest - 1)
    if (base !== undefined) {
      const uri = reviveFileUri(base)
      if (uri) {
        const key = this._uriIdentity.getComparisonKey(uri)
        const entry = this._bases.get(key)
        if (entry) {
          entry.count--
          if (entry.count <= 0) {
            this._bases.delete(key)
            this._syncOutOfWorkspaceWatch()
          }
        }
      }
    }
    return Promise.resolve()
  }

  override dispose(): void {
    if (this._bases.size > 0) {
      this._bases.clear()
      // The connection is going away; release every armed folder watch.
      void this._watcher.watchOutOfWorkspaceFolders([]).catch((err: unknown) => {
        this._logger.warn(`clearing out-of-workspace watches failed: ${(err as Error).message}`)
      })
    }
    super.dispose()
  }

  private _syncOutOfWorkspaceWatch(): void {
    const folders = Array.from(this._bases.values(), (e) => e.uri)
    if (folders.length === 0 && !this._foldersArmed) return
    this._foldersArmed = folders.length > 0
    this._logger.debug(`out-of-workspace watch folders: ${folders.length}`)
    void this._watcher.watchOutOfWorkspaceFolders(folders).catch((err: unknown) => {
      this._logger.warn(`out-of-workspace watch update failed: ${(err as Error).message}`)
    })
  }

  private _forward(events: readonly IFileChangeEvent[]): void {
    if (this._interest === 0 || events.length === 0) return
    let batch = events
    if (events.length > MAX_EVENTS_PER_BATCH) {
      this._logger.warn(`file events batch truncated: ${events.length} → ${MAX_EVENTS_PER_BATCH}`)
      batch = events.slice(0, MAX_EVENTS_PER_BATCH)
    }
    const dtos: IFileChangeEventDto[] = batch.map((e) => ({
      type: e.type === 'added' ? 'created' : e.type === 'deleted' ? 'deleted' : 'changed',
      uri: e.resource.toJSON(),
    }))
    void this._extHost.$acceptFileEvents(dtos).catch((err: unknown) => {
      this._logger.warn(`file events push failed: ${(err as Error).message}`)
    })
  }
}
