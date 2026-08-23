/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenAI Responses provider — a stub for the `openai-responses` wire protocol. It
 *  enumerates no models (the editor never calls this protocol) and rejects every
 *  editor request: only agents drive the Responses protocol today.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AsyncIterableSource,
  DeferredPromise,
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

export class OpenAiResponsesProvider implements IAiModelProvider {
  async listModels(
    _provider: AiProviderRuntime,
    _token: CancellationToken,
  ): Promise<readonly string[]> {
    return []
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
