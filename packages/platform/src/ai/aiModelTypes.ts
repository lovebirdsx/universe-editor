/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Vendor-neutral data structures for the AI model service. Distilled from
 *  VSCode's ILanguageModelChatMetadata / IChatMessage, stripped of extension /
 *  chat business fields, keeping an extensible skeleton.
 *--------------------------------------------------------------------------------------------*/

/** Self-describing model metadata, so consumers can pick a model by capability. */
export interface AiModelMetadata {
  /** Globally unique id, e.g. 'openai/gpt-4o'. */
  readonly id: string
  /** Registration key / namespace, e.g. 'openai'. */
  readonly vendor: string
  /** Display name. */
  readonly name: string
  /** Family groups versions of the same model, e.g. 'gpt-4o'. */
  readonly family: string
  readonly version?: string
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly capabilities: AiModelCapabilities
}

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

/** Per-request options that override the merged defaults for a single call. */
export interface AiRequestOptions {
  readonly modelId: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  /** Vendor-specific extras passed through to the provider after config merge. */
  readonly extra?: Readonly<Record<string, unknown>>
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
