/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenAI Responses provider — the `openai-responses` wire protocol. Only agents
 *  drive Responses today, so every editor request is rejected; `listModels` is
 *  real, because it is how the agent settings panel proves a gateway answers.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AsyncIterableSource,
  DeferredPromise,
  DisposableStore,
  type AiMessage,
  type AiRequestOptions,
  type AiProviderRuntime,
  type AiResponse,
  type AiRequestResult,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
  localize,
} from '@universe-editor/platform'
import { modelsEndpointError, modelsNetworkError, toAbortSignal } from './retry.js'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

interface OpenAiModelEntry {
  readonly id: string
}

export class OpenAiResponsesProvider implements IAiModelProvider {
  async listModels(
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const signals = new DisposableStore()
    let res: Response
    try {
      res = await fetch(`${baseUrl(provider)}/models`, {
        headers: authHeaders(provider.apiKey),
        signal: toAbortSignal(token, signals),
      })
    } catch (err) {
      throw modelsNetworkError(err, token)
    } finally {
      signals.dispose()
    }
    if (!res.ok) throw modelsEndpointError(res.status)
    return (((await res.json()) as { data?: OpenAiModelEntry[] }).data ?? []).map(
      (entry) => entry.id,
    )
  }

  sendRequest(
    _messages: readonly AiMessage[],
    _options: AiRequestOptions,
    _provider: AiProviderRuntime,
    _token: CancellationToken,
  ): AiResponse {
    const source = new AsyncIterableSource<AiResponseChunk>()
    const result = new DeferredPromise<AiRequestResult>()
    // A consumer may read only `stream`; keep result from surfacing unhandled.
    result.p.catch(() => undefined)

    const error = new AiError(
      AiErrorCode.ConfigurationRequired,
      localize(
        'ai.error.responsesNotSupported',
        'The OpenAI Responses protocol is only available to agents; pick a chat-protocol model for editor features.',
      ),
    )
    source.reject(error)
    result.error(error)
    return { stream: source.asyncIterable, result: result.p }
  }

  async provideTokenCount(_modelId: string, text: string): Promise<number> {
    return Math.ceil(text.length / 4)
  }
}

function baseUrl(provider: AiProviderRuntime): string {
  return (provider.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}
