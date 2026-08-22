/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider contract: one implementation per wire protocol. A provider
 *  translates a standardized request into that protocol's HTTP API and its
 *  response back into standard chunks. It knows nothing about the registry,
 *  cache, or IPC.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import type { AiResolvedProvider } from './aiModelConfiguration.js'
import type { AiResponse } from './aiModelService.js'
import type { AiMessage, AiModelMetadata, AiRequestOptions } from './aiModelTypes.js'

export interface IAiModelProvider {
  /**
   * Which models this instance currently offers. May depend on a configured API
   * key — return an empty list when no key is available. Endpoint-enumerated
   * models are merged with the instance's hand-declared `declaredModels`. A
   * single instance may hold models across several protocols: each protocol's
   * provider receives only the declaredModels already filtered to its protocol
   * (see the registry's per-protocol bucket view).
   */
  provideModels(
    provider: AiResolvedProvider,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]>

  /**
   * Execute one request against `provider`. The provider:
   *  - reads the instance's apiKey / baseUrl
   *  - translates AiMessage[] into the protocol HTTP body
   *  - translates the streamed response back into AiResponseChunk, yielding each
   *  - listens to `token.onCancellationRequested` to abort the network request
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    provider: AiResolvedProvider,
    token: CancellationToken,
  ): AiResponse

  provideTokenCount(
    modelId: string,
    text: string,
    provider: AiResolvedProvider,
    token: CancellationToken,
  ): Promise<number>
}
