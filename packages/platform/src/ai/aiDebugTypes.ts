/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Vendor-neutral debug-record shapes for AI requests that flow through the
 *  main-process AiModelMainService ("direct provider" path). Captured by the
 *  AiDebugRecorder, surfaced in the AI Debug side panel, and replayable offline.
 *  Holds no API keys — request options never carry secrets.
 *--------------------------------------------------------------------------------------------*/

import type { SerializedError } from '../base/errors.js'
import type { AiMessageRole } from './aiModelTypes.js'
import type { AiRequestOptions, AiRequestPurpose, AiResponseChunk } from './aiModelTypes.js'

export type AiDebugStatus = 'pending' | 'ok' | 'error' | 'canceled'

/** A request message flattened to plain text for display (images → placeholder). */
export interface AiDebugMessage {
  readonly role: AiMessageRole
  readonly text: string
}

/** One recorded response chunk with its arrival offset (ms from request start), for replay. */
export interface AiDebugChunk {
  readonly atMs: number
  readonly chunk: AiResponseChunk
}

/** Full debug record for one AI request. */
export interface AiDebugRecord {
  readonly id: string
  /** The in-flight requestId used by the chunk/end event pipeline; reused for replay. */
  readonly requestId: string
  readonly purpose?: AiRequestPurpose
  readonly debugLabel?: string
  readonly modelId: string
  readonly vendor: string
  readonly groupName?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly status: AiDebugStatus
  readonly messages: readonly AiDebugMessage[]
  /** Request options minus the model id (kept as a dedicated field). */
  readonly options: Omit<AiRequestOptions, 'modelId' | 'purpose' | 'debugLabel'>
  readonly responseText: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
  /** Ordered response chunks, replayable as mock data without calling the model. */
  readonly chunks: readonly AiDebugChunk[]
  readonly error?: SerializedError
}

/** Lightweight list-view projection of {@link AiDebugRecord}. */
export interface AiDebugRecordSummary {
  readonly id: string
  readonly purpose?: AiRequestPurpose
  readonly debugLabel?: string
  readonly modelId: string
  readonly startedAt: number
  readonly durationMs?: number
  readonly status: AiDebugStatus
  readonly responsePreview: string
  readonly tokens?: { readonly inputTokens: number; readonly outputTokens: number }
}
