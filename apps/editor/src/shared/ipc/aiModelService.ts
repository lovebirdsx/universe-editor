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
  AiActiveModelKind,
  AiMessageRole,
  AiModelConfiguration,
  AiModelMetadata,
  AiModelSelector,
  AiProviderGroup,
  AiPromptKind,
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

/** Signals which active-model slot changed. */
export interface AiActiveModelChangeEvent {
  readonly kind: AiActiveModelKind
}

/**
 * Transport-level main service. `on*` properties are bridged to `listen` by
 * ProxyChannel; everything else is a `call`. Provider groups & per-model config
 * are read by main directly from aiSettings.json — no renderer push.
 */
export interface IAiModelMainService {
  readonly _serviceBrand: undefined

  readonly onDidEmitChunk: Event<AiChunkEvent>
  readonly onDidEndRequest: Event<AiEndEvent>
  readonly onDidChangeModels: Event<void>
  readonly onDidChangeActiveModel: Event<AiActiveModelChangeEvent>
  readonly onDidChangeSystemPrompts: Event<void>

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

  /** The active model id for a slot, or undefined if none. */
  getActiveModel(kind: AiActiveModelKind): Promise<string | undefined>
  /** Set the active model id for a slot (writes aiSettings.json, fires onDidChangeActiveModel). */
  setActiveModel(kind: AiActiveModelKind, modelId: string | undefined): Promise<void>

  /** A feature's system-prompt override, or undefined when it uses its built-in default. */
  getSystemPrompt(kind: AiPromptKind): Promise<string | undefined>
  /** Set (or clear) a feature's system-prompt override (writes aiSettings.json, fires onDidChangeSystemPrompts). */
  setSystemPrompt(kind: AiPromptKind, prompt: string | undefined): Promise<void>

  /** Resolved per-model configuration (schema default → user settings). */
  getModelConfiguration(modelId: string): Promise<AiModelConfiguration>
  /** Persist per-model configuration into aiSettings.json (defaults dropped). */
  setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void>

  /** The persisted provider groups (secret-free) backing aiSettings.json. */
  getGroups(): Promise<readonly AiProviderGroup[]>
  /** Replace the persisted provider groups (rewrites aiSettings.json; no secrets). */
  updateGroups(groups: readonly AiProviderGroup[]): Promise<void>

  /** Store a group's API key in encrypted secret storage (plaintext stays in main). */
  setApiKey(vendor: string, group: string, key: string): Promise<void>
  /** Remove a group's stored API key. */
  deleteApiKey(vendor: string, group: string): Promise<void>
  /** Whether a group currently has an API key stored. */
  hasApiKey(vendor: string, group: string): Promise<boolean>
}

export const IAiModelMainService = createDecorator<IAiModelMainService>('aiModelMainService')
