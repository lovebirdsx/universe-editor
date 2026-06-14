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
  AiModelMetadata,
  AiModelSelector,
  AiRequestOptions,
  AiResponseChunk,
} from './aiModelTypes.js'

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

export interface IAiModelService {
  readonly _serviceBrand: undefined

  /** Fires when the set of available models changes (e.g. a key was configured). */
  readonly onDidChangeModels: Event<void>

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
