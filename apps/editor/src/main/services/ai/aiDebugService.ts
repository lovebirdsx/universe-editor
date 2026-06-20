/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side AI debug service. Reads recordings from AiDebugRecorder and replays
 *  them as mock data (no model call) over replayId-keyed events. Exposed to the
 *  renderer's AI Debug side panel via ProxyChannel.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  generateUuid,
  type AiDebugRecord,
  type AiDebugRecordSummary,
} from '@universe-editor/platform'
import type {
  AiReplayChunkEvent,
  AiReplayEndEvent,
  IAiDebugService,
} from '../../../shared/ipc/aiDebugService.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './aiDebugRecorder.js'

export class AiDebugMainService extends Disposable implements IAiDebugService {
  declare readonly _serviceBrand: undefined

  readonly onDidRecordRequest: Emitter<AiDebugRecordSummary>['event']
  readonly onDidClear: Emitter<void>['event']

  private readonly _onDidReplayChunk = this._register(new Emitter<AiReplayChunkEvent>())
  readonly onDidReplayChunk = this._onDidReplayChunk.event

  private readonly _onDidReplayEnd = this._register(new Emitter<AiReplayEndEvent>())
  readonly onDidReplayEnd = this._onDidReplayEnd.event

  private readonly _timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(@IAiDebugRecorderService private readonly _recorder: AiDebugRecorder) {
    super()
    this.onDidRecordRequest = this._recorder.onDidRecordRequest
    this.onDidClear = this._recorder.onDidClear
  }

  listRecords(opts?: {
    limit?: number
    offset?: number
  }): Promise<readonly AiDebugRecordSummary[]> {
    return Promise.resolve(this._recorder.listRecords(opts))
  }

  getRecord(id: string): Promise<AiDebugRecord | undefined> {
    return Promise.resolve(this._recorder.getRecord(id))
  }

  clearRecords(): Promise<void> {
    this._recorder.clearRecords()
    return Promise.resolve()
  }

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this._recorder.isEnabled())
  }

  setEnabled(enabled: boolean): Promise<void> {
    this._recorder.setEnabled(enabled)
    return Promise.resolve()
  }

  replayRecord(id: string, opts?: { realtime?: boolean }): Promise<string | undefined> {
    const record = this._recorder.getRecord(id)
    if (!record) return Promise.resolve(undefined)
    const replayId = generateUuid()
    this._runReplay(replayId, record, opts?.realtime ?? false)
    return Promise.resolve(replayId)
  }

  private _runReplay(replayId: string, record: AiDebugRecord, realtime: boolean): void {
    const emitEnd = (): void => {
      this._onDidReplayEnd.fire(record.error ? { replayId, error: record.error } : { replayId })
    }

    if (!realtime) {
      for (const c of record.chunks) {
        this._onDidReplayChunk.fire({ replayId, chunk: c.chunk })
      }
      emitEnd()
      return
    }

    // Realtime: pace each chunk by its recorded arrival offset, then end after
    // the last one. setTimeout handles are tracked so dispose() can cancel them.
    let lastAt = 0
    for (const c of record.chunks) {
      lastAt = c.atMs
      this._schedule(c.atMs, () => this._onDidReplayChunk.fire({ replayId, chunk: c.chunk }))
    }
    this._schedule(lastAt, emitEnd)
  }

  private _schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(
      () => {
        this._timers.delete(timer)
        fn()
      },
      Math.max(0, delayMs),
    )
    this._timers.add(timer)
  }

  override dispose(): void {
    for (const t of this._timers) clearTimeout(t)
    this._timers.clear()
    super.dispose()
  }
}
