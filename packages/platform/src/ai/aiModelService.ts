/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Facade interface for the AI model service — the single, stable dependency for
 *  all consumers (inline suggestions, commit message generation, …). It knows no
 *  vendor specifics. Aligned with VSCode's ILanguageModelsService.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type {
  AiMessage,
  AiModelConfiguration,
  AiModelMetadata,
  AiModelSelector,
  AiRequestOptions,
  AiResponseChunk,
} from './aiModelTypes.js'
import type { AiProviderVerifyInput, AiProviderVerifyResult } from './aiModelConfiguration.js'
import type { AiModelKnowledge, AiProviderEntry, AiProviderIssue } from './aiProviderEntry.js'
import type { AiAccountUsage, AiRateTable } from './aiRemoteSources.js'

/** Mirrors VSCode's ILanguageModelChatResponse: stream + final result split. */
export interface AiResponse {
  /** Produces text / usage chunks as they arrive. */
  readonly stream: AsyncIterable<AiResponseChunk>
  /** Resolves when the whole request completes, or rejects on failure. */
  readonly result: Promise<AiRequestResult>
}

export interface AiRequestResult {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Mirror of one provider's remote rate table, kept for synchronous lookups. */
export interface AiRateTableSnapshot {
  readonly providerId: string
  readonly rates: AiRateTable
  readonly fetchedAt: number
}

export interface IAiModelService {
  readonly _serviceBrand: undefined

  /** Fires when the set of available models changes (e.g. a key was configured). */
  readonly onDidChangeModels: Event<void>

  /** Fires when the active chat model selection changes (persisted in aiSettings.json). */
  readonly onDidChangeActiveModel: Event<void>

  /** Fires when the active inline-completion model selection changes (persisted in aiSettings.json). */
  readonly onDidChangeInlineCompletionModel: Event<void>

  /** Fires when the active commit-message model selection changes (persisted in aiSettings.json). */
  readonly onDidChangeCommitModel: Event<void>

  /** Fires when the active session-title model selection changes (persisted in aiSettings.json). */
  readonly onDidChangeSessionTitleModel: Event<void>

  /** Fires when remote sources (rates / usage) change. */
  readonly onDidChangeRemote: Event<void>

  /** List currently available models (resolved, with metadata). */
  getModels(): Promise<readonly AiModelMetadata[]>

  /** Pick models by condition; returns matching model ids. */
  selectModels(selector: AiModelSelector): Promise<readonly string[]>

  /**
   * Issue a request. Returns a clean stream + final-result promise.
   * Cancellation via `token` propagates across the process boundary and aborts
   * the underlying network request.
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse

  /** Count tokens for `text` under `modelId` (to trim context to maxInputTokens). */
  computeTokenLength(modelId: string, text: string, token: CancellationToken): Promise<number>

  /** The active chat model id, or undefined if none (persisted in aiSettings.json by main). */
  getActiveModelId(): Promise<string | undefined>
  /** Set the active chat model id (persisted in aiSettings.json by main). */
  setActiveModelId(modelId: string | undefined): Promise<void>

  /** The active inline-completion model id, or undefined if none (persisted in aiSettings.json by main). */
  getInlineCompletionModelId(): Promise<string | undefined>
  /** Set the active inline-completion model id (persisted in aiSettings.json by main). */
  setInlineCompletionModelId(modelId: string | undefined): Promise<void>

  /** The active commit-message model id, or undefined if none (persisted in aiSettings.json by main). */
  getCommitModelId(): Promise<string | undefined>
  /** Set the active commit-message model id (persisted in aiSettings.json by main). */
  setCommitModelId(modelId: string | undefined): Promise<void>

  /** The active session-title model id, or undefined if none (persisted in aiSettings.json by main). */
  getSessionTitleModelId(): Promise<string | undefined>
  /** Set the active session-title model id (persisted in aiSettings.json by main). */
  setSessionTitleModelId(modelId: string | undefined): Promise<void>

  /** Resolved per-model configuration (schema default → user settings). */
  getModelConfiguration(modelId: string): Promise<AiModelConfiguration>
  /** Persist per-model configuration; values equal to the schema default are dropped. */
  setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void>

  /** The persisted provider entries backing aiSettings.json (apiKey included, never logged). */
  getProviders(): Promise<readonly AiProviderEntry[]>
  /** Replace the persisted provider entries (rewrites aiSettings.json). */
  updateProviders(providers: readonly AiProviderEntry[]): Promise<void>

  /** Model knowledge base in effect: built-in merged with the user layer in aiSettings.json. */
  getModelKnowledge(): Promise<Readonly<Record<string, AiModelKnowledge>>>

  /** The user's own `models` layer from aiSettings.json — never the merged view. */
  getUserModelKnowledge(): Promise<Readonly<Record<string, AiModelKnowledge>>>
  /** Replace the user's `models` layer wholesale. Built-in knowledge is untouched. */
  updateModelKnowledge(models: Readonly<Record<string, AiModelKnowledge>>): Promise<void>
  /**
   * Replace the user's `models` layer and the provider entries in ONE write.
   * Renaming a knowledge key has to do both — the key and the `protocolMap` refs
   * pointing at it — and two sequential writes can fail in between, leaving refs
   * dangling at a key that no longer exists.
   */
  updateModelKnowledgeAndProviders(
    models: Readonly<Record<string, AiModelKnowledge>>,
    providers: readonly AiProviderEntry[],
  ): Promise<void>

  /** Configuration problems found while resolving `providers[]` (bad extends, no protocol, …). */
  getProviderIssues(): Promise<readonly AiProviderIssue[]>

  /** Whether aiSettings.json is still in the retired two-layer format and was ignored. */
  isLegacySettingsFormat(): Promise<boolean>

  /** Probe a candidate entry against its endpoint without persisting anything. */
  verifyProvider(input: AiProviderVerifyInput): Promise<AiProviderVerifyResult>

  /** Store an entry's plaintext apiKey (user's explicit decision: cross-machine sync); never logged. */
  setApiKey(providerId: string, key: string): Promise<void>
  /** Remove an entry's stored apiKey. */
  deleteApiKey(providerId: string): Promise<void>
  /** Whether an entry currently has an apiKey stored. */
  hasApiKey(providerId: string): Promise<boolean>

  /** Latest rate tables by provider id, for synchronous lookups on the renderer mirror. */
  getRateTables(): Promise<readonly AiRateTableSnapshot[]>
  /** Authoritative account-level usage for a provider; undefined means unavailable (never estimated). */
  getAccountUsage(providerId: string): Promise<AiAccountUsage | undefined>
  /** Refresh remote sources (rates + usage). Omit `providerId` to refresh all. */
  refreshRemote(providerId?: string): Promise<void>
}

export const IAiModelService = createDecorator<IAiModelService>('aiModelService')

/**
 * Drain an {@link AiResponse} into a single string. Mirrors VSCode's
 * `getTextResponseFromStream`: tolerant of a stream that errors after already
 * yielding some text — returns the partial text rather than throwing, unless no
 * text was produced at all.
 */
export async function getTextResponse(response: AiResponse): Promise<string> {
  let text = ''
  try {
    for await (const chunk of response.stream) {
      if (chunk.type === 'text') text += chunk.value
    }
  } catch (err) {
    if (text.length === 0) throw err
  }
  return text
}
