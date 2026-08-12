/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFileEvents — the renderer end of the file-events pair backing
 *  `workspace.createFileSystemWatcher`. It reuses the workbench's existing
 *  recursive workspace watch (IFileWatcherService) instead of arming a native
 *  watcher per extension watcher, and forwards event batches to the host only
 *  while the host declared interest ($subscribeFileEvents → at least one live
 *  extension watcher), so a host with no watchers costs zero RPC traffic.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IFileChangeEvent,
  type IFileWatcherService,
  type ILogger,
} from '@universe-editor/platform'
import type {
  IFileChangeEventDto,
  IExtHostFileEvents,
  IMainThreadFileEvents,
} from '@universe-editor/extensions-common'

/** Batch cap so a mass change (branch switch, build clean) can't flood the
 *  newline-JSON RPC — this repo has an RPC-flood OOM history. */
const MAX_EVENTS_PER_BATCH = 5000

export class MainThreadFileEvents extends Disposable implements IMainThreadFileEvents {
  private _interest = 0

  constructor(
    private readonly _watcher: IFileWatcherService,
    private readonly _extHost: IExtHostFileEvents,
    private readonly _logger: ILogger,
  ) {
    super()
    this._register(this._watcher.onDidChangeFiles((events) => this._forward(events)))
  }

  $subscribeFileEvents(): Promise<void> {
    this._interest++
    return Promise.resolve()
  }

  $unsubscribeFileEvents(): Promise<void> {
    this._interest = Math.max(0, this._interest - 1)
    return Promise.resolve()
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
