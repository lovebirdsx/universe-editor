/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Vendor-neutral data structures for the AI model service. Distilled from
 *  VSCode's ILanguageModelChatMetadata / IChatMessage, stripped of extension /
 *  chat business fields, keeping an extensible skeleton.
 *--------------------------------------------------------------------------------------------*/

/** Self-describing model metadata, so consumers can pick a model by capability. */
export interface AiModelMetadata {
  /** Globally unique id, three-segment `vendor/group/model`, e.g. 'openai/default/gpt-4o'. */
  readonly id: string
  /** Registration key / namespace, e.g. 'openai'. */
  readonly vendor: string
  /** Provider group this model belongs to, e.g. 'default'. */
  readonly groupName?: string
  /** Display name. */
  readonly name: string
  /** Family groups versions of the same model, e.g. 'gpt-4o'. */
  readonly family: string
  readonly version?: string
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly capabilities: AiModelCapabilities
  /** Per-model configurable parameters, surfaced in the picker / management UI. */
  readonly configurationSchema?: AiModelConfigSchema
}

/**
 * Lightweight per-model configuration schema (distilled from VSCode's
 * `configurationSchema`). Each property describes one tunable request parameter.
 */
export type AiModelConfigSchema = Readonly<Record<string, AiModelConfigProperty>>

export interface AiModelConfigProperty {
  readonly type: 'string' | 'number' | 'boolean' | 'enum'
  /** Allowed values when `type` is 'enum'. */
  readonly enum?: readonly string[]
  readonly default?: string | number | boolean
  readonly description?: string
  /** 'navigation' hints the UI to surface this property in the picker's main area. */
  readonly group?: 'navigation'
}

/** Resolved per-model configuration values (schema default → user settings). */
export type AiModelConfiguration = Readonly<Record<string, string | number | boolean>>

export interface AiModelCapabilities {
  readonly streaming: boolean
  readonly vision?: boolean
  /** Reserved; tool calling is not implemented this iteration. */
  readonly toolCalling?: boolean
}

export const enum AiMessageRole {
  System = 0,
  User = 1,
  Assistant = 2,
}

export interface AiMessage {
  readonly role: AiMessageRole
  readonly content: readonly AiMessagePart[]
}

export type AiMessagePart =
  | { readonly type: 'text'; readonly value: string }
  // Reserved for vision. `data` is a Uint8Array in-process; crossing IPC needs a
  // serializable form (see shared/ipc/aiModelService DTO conversion).
  | { readonly type: 'image'; readonly mimeType: string; readonly data: Uint8Array }

/**
 * What a request is for. Surfaced in the AI debug recorder so each recorded call
 * is attributable to the feature that issued it. Carried on {@link AiRequestOptions}
 * and threaded transparently through every transport boundary.
 */
export type AiRequestPurpose =
  | 'chat'
  | 'inline-completion'
  | 'next-edit-suggestion'
  | 'session-title'
  | 'commit'
  | 'extension'

/** Per-request options that override the merged defaults for a single call. */
export interface AiRequestOptions {
  readonly modelId: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  /** Resolved per-model configuration (schema default → user settings) for this model. */
  readonly modelConfiguration?: AiModelConfiguration
  /** Vendor-specific extras passed through to the provider after config merge. */
  readonly extra?: Readonly<Record<string, unknown>>
  /** Feature that issued this request; used to attribute debug recordings. */
  readonly purpose?: AiRequestPurpose
  /** Free-form sub-label (e.g. an extension id) shown alongside the purpose. */
  readonly debugLabel?: string
}

/** Smallest unit of a streamed response; this is what crosses the IPC boundary. */
export type AiResponseChunk =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
// Future: 'tool_use' | 'thinking' …

/** Select a model by condition instead of hardcoding an id. */
export interface AiModelSelector {
  readonly vendor?: string
  readonly family?: string
  readonly id?: string
  readonly capabilities?: Partial<AiModelCapabilities>
}

/** Coarse error classification a provider maps HTTP failures onto. */
export const enum AiErrorCode {
  ProviderUnavailable = 'providerUnavailable',
  ModelNotFound = 'modelNotFound',
  ConfigurationRequired = 'configurationRequired',
  NoPermission = 'noPermission',
  Unauthorized = 'unauthorized',
  RateLimited = 'rateLimited',
  QuotaExceeded = 'quotaExceeded',
  NetworkError = 'networkError',
  Canceled = 'canceled',
  Unknown = 'unknown',
}

/** Error carrying an {@link AiErrorCode}, so consumers can give targeted feedback. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export function getAiErrorCode(error: unknown): AiErrorCode | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? (code as AiErrorCode) : undefined
}
