/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the AI model service. The renderer holds a clean
 *  IAiModelService facade (platform) that wraps this transport-level interface;
 *  main implements it. Streaming crosses the boundary as discrete chunk events
 *  keyed by requestId (IPC cannot carry an AsyncIterable), mirroring acpHost.
 *
 *  DTO note: AiMessagePart.image carries a Uint8Array in-process; over IPC it is
 *  encoded as base64 (`AiMessagePartDto`). The renderer client converts at the
 *  boundary, analogous to the project's "URI must be revived after IPC" rule.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  AiMessageRole,
  AiModelMetadata,
  AiModelSelector,
  AiRequestOptions,
  AiResponseChunk,
  Event,
  SerializedError,
} from '@universe-editor/platform'

/** Serializable form of AiMessagePart (image data as base64 instead of bytes). */
export type AiMessagePartDto =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly dataBase64: string }

export interface AiMessageDto {
  readonly role: AiMessageRole
  readonly content: readonly AiMessagePartDto[]
}

/** A streamed chunk tagged with the request it belongs to. */
export interface AiChunkEvent {
  readonly requestId: string
  readonly chunk: AiResponseChunk
}

/** End-of-request signal; `error` present iff the request failed. */
export interface AiEndEvent {
  readonly requestId: string
  readonly error?: SerializedError
}

/** Non-secret config resolved by the renderer and pushed to main (no API key). */
export interface AiVendorConfigDto {
  readonly baseUrl?: string
  readonly defaultModel?: string
}

export interface AiResolvedConfigDto {
  /** Keyed by vendor, e.g. { ollama: { baseUrl, defaultModel } }. */
  readonly vendors: Readonly<Record<string, AiVendorConfigDto>>
  /** Global request defaults (overridable per request). */
  readonly request: {
    readonly temperature?: number
    readonly maxTokens?: number
  }
}

/**
 * Transport-level main service. `on*` properties are bridged to `listen` by
 * ProxyChannel; everything else is a `call`.
 */
export interface IAiModelMainService {
  readonly _serviceBrand: undefined

  readonly onDidEmitChunk: Event<AiChunkEvent>
  readonly onDidEndRequest: Event<AiEndEvent>
  readonly onDidChangeModels: Event<void>

  getModels(): Promise<readonly AiModelMetadata[]>
  selectModels(selector: AiModelSelector): Promise<readonly string[]>
  computeTokenLength(modelId: string, text: string): Promise<number>

  /** Fire a request; chunks/end come back via the events keyed by `requestId`. */
  startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void>
  /** Cancel an in-flight request — aborts the underlying network call in main. */
  cancelRequest(requestId: string): Promise<void>

  /** Push the renderer-resolved non-secret config (schema default + user layers). */
  setConfig(config: AiResolvedConfigDto): Promise<void>
}

export const IAiModelMainService = createDecorator<IAiModelMainService>('aiModelMainService')
