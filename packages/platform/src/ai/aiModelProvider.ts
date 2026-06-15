/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider contract: one implementation per vendor. A provider translates a
 *  standardized request into that vendor's HTTP API and its response back into
 *  standard chunks. It knows nothing about the registry, cache, or IPC.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import type { AiResolvedGroup } from './aiModelConfiguration.js'
import type { AiResponse } from './aiModelService.js'
import type { AiMessage, AiModelMetadata, AiRequestOptions } from './aiModelTypes.js'

export interface IAiModelProvider {
  /**
   * Which models this group currently offers. May depend on a configured API
   * key — return an empty list when no key is available. Endpoint-enumerated
   * models are merged with the group's hand-declared `declaredModels`.
   */
  provideModels(
    group: AiResolvedGroup,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]>

  /**
   * Execute one request against `group`. The provider:
   *  - reads the group's key / baseUrl
   *  - translates AiMessage[] into the vendor HTTP body
   *  - translates the streamed response back into AiResponseChunk, yielding each
   *  - listens to `token.onCancellationRequested` to abort the network request
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    group: AiResolvedGroup,
    token: CancellationToken,
  ): AiResponse

  provideTokenCount(
    modelId: string,
    text: string,
    group: AiResolvedGroup,
    token: CancellationToken,
  ): Promise<number>
}
