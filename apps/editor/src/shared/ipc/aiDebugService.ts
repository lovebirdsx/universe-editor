/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the AI debug service. Main captures every "direct provider"
 *  AI request (via AiDebugRecorder) and exposes the records to the renderer's AI
 *  Debug side panel. Replay re-emits a record's chunks as mock data without
 *  calling the model, streamed back over requestId-keyed events.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  AiDebugChunk,
  AiDebugRecord,
  AiDebugRecordSummary,
  Event,
  SerializedError,
} from '@universe-editor/platform'

/** A replayed chunk tagged with the replay run it belongs to. */
export interface AiReplayChunkEvent {
  readonly replayId: string
  readonly chunk: AiDebugChunk['chunk']
}

/** End-of-replay signal; `error` present iff the original request had failed. */
export interface AiReplayEndEvent {
  readonly replayId: string
  readonly error?: SerializedError
}

export interface IAiDebugService {
  readonly _serviceBrand: undefined

  /** Fires when a request finishes recording, carrying its summary. */
  readonly onDidRecordRequest: Event<AiDebugRecordSummary>
  /** Fires when records are cleared. */
  readonly onDidClear: Event<void>
  /** Streams chunks of an in-progress replay, keyed by replayId. */
  readonly onDidReplayChunk: Event<AiReplayChunkEvent>
  /** Signals a replay finished, keyed by replayId. */
  readonly onDidReplayEnd: Event<AiReplayEndEvent>

  listRecords(opts?: { limit?: number; offset?: number }): Promise<readonly AiDebugRecordSummary[]>
  getRecord(id: string): Promise<AiDebugRecord | undefined>
  clearRecords(): Promise<void>
  isEnabled(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<void>

  /**
   * Replay a recorded request as mock data. Returns a fresh replayId; chunks
   * arrive via `onDidReplayChunk` and completion via `onDidReplayEnd`. When
   * `realtime` is true, chunks are paced by their original arrival offsets.
   */
  replayRecord(id: string, opts?: { realtime?: boolean }): Promise<string | undefined>
}

export const IAiDebugService = createDecorator<IAiDebugService>('aiDebugService')
