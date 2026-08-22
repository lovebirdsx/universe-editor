/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenAI Responses provider — a stub for the `openai-responses` wire protocol. It lists
 *  hand-declared models (so they still appear, get priced, and derive agents) but rejects
 *  every editor request: only agents drive the Responses protocol today.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AsyncIterableSource,
  composeModelId,
  DeferredPromise,
  type AiCustomModelConfig,
  type AiMessage,
  type AiRequestOptions,
  type AiResolvedProvider,
  type AiResponse,
  type AiRequestResult,
  type AiModelMetadata,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
  localize,
} from '@universe-editor/platform'
import { resolveModelPricing } from '../../../../shared/ai/resolveModelPricing.js'

const DEFAULT_MAX_TOKENS = 8192

export class OpenAiResponsesProvider implements IAiModelProvider {
  async provideModels(
    provider: AiResolvedProvider,
    _token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    return (provider.declaredModels ?? []).map((config) => declaredMetadata(provider, config))
  }

  sendRequest(
    _messages: readonly AiMessage[],
    _options: AiRequestOptions,
    _provider: AiResolvedProvider,
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

function declaredMetadata(
  provider: AiResolvedProvider,
  config: AiCustomModelConfig,
): AiModelMetadata {
  const modelId = composeModelId(provider.type, provider.name, config.id)
  const resolved = resolveModelPricing({
    modelId,
    model: config,
    typePricing: provider.typePricing,
  })
  return {
    id: modelId,
    vendor: provider.type,
    groupName: provider.name,
    name: config.name ?? config.id,
    family: config.family ?? config.id,
    maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_TOKENS,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    capabilities: config.capabilities ?? { streaming: true },
    ...(resolved.pricing !== undefined ? { pricing: resolved.pricing } : {}),
    ...(resolved.origin !== undefined ? { pricingOrigin: resolved.origin } : {}),
  }
}
