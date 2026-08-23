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
 *
 *  Secret note: provider DTOs carry a plaintext apiKey (`AiProviderEntry.apiKey`).
 *  This is an explicit user decision — keys sync across machines in aiSettings.json
 *  rather than staying in per-device encrypted storage. Logs and AI Debug records
 *  still never contain the key.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  AiAccountUsage,
  AiActiveModelKind,
  AiMessageRole,
  AiModelConfiguration,
  AiModelKnowledge,
  AiModelMetadata,
  AiModelSelector,
  AiProviderEntry,
  AiProviderIssue,
  AiProviderVerifyInput,
  AiProviderVerifyResult,
  AiRateTableSnapshot,
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
 * ProxyChannel; everything else is a `call`. Provider instances, per-model config
 * and the active model selections are read by main directly from aiSettings.json —
 * no renderer push.
 */
export interface IAiModelMainService {
  readonly _serviceBrand: undefined

  readonly onDidEmitChunk: Event<AiChunkEvent>
  readonly onDidEndRequest: Event<AiEndEvent>
  readonly onDidChangeModels: Event<void>
  readonly onDidChangeActiveModel: Event<AiActiveModelChangeEvent>
  readonly onDidChangeRemote: Event<void>

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

  /** Resolved per-model configuration (schema default → user settings). */
  getModelConfiguration(modelId: string): Promise<AiModelConfiguration>
  /** Persist per-model configuration into aiSettings.json (defaults dropped). */
  setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void>

  /** The persisted provider entries backing aiSettings.json (apiKey inline). */
  getProviders(): Promise<readonly AiProviderEntry[]>
  /** Replace the persisted provider entries (rewrites aiSettings.json). */
  updateProviders(providers: readonly AiProviderEntry[]): Promise<void>

  /** Effective model knowledge base: built-in merged with the user layer. */
  getModelKnowledge(): Promise<Readonly<Record<string, AiModelKnowledge>>>
  /** Configuration problems found while resolving `providers[]`. */
  getProviderIssues(): Promise<readonly AiProviderIssue[]>
  /** Whether aiSettings.json is still in the retired two-layer format and was ignored. */
  isLegacySettingsFormat(): Promise<boolean>

  /** Probe a candidate entry against its endpoint without persisting anything. */
  verifyProvider(input: AiProviderVerifyInput): Promise<AiProviderVerifyResult>

  /** Store an entry's plaintext apiKey (user decision: cross-machine sync); never logged. */
  setApiKey(providerId: string, key: string): Promise<void>
  /** Remove an entry's stored apiKey. */
  deleteApiKey(providerId: string): Promise<void>
  /** Whether an entry currently has an apiKey stored. */
  hasApiKey(providerId: string): Promise<boolean>

  /** Latest rate tables by provider id, for the renderer's synchronous mirror. */
  getRateTables(): Promise<readonly AiRateTableSnapshot[]>
  /** Authoritative account-level usage for a provider; undefined means unavailable. */
  getAccountUsage(providerId: string): Promise<AiAccountUsage | undefined>
  /** Refresh remote sources (rates + usage). Omit `providerId` to refresh all. */
  refreshRemote(providerId?: string): Promise<void>
}

export const IAiModelMainService = createDecorator<IAiModelMainService>('aiModelMainService')
