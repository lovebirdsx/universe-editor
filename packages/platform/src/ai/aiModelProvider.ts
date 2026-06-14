/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider contract: one implementation per vendor. A provider translates a
 *  standardized request into that vendor's HTTP API and its response back into
 *  standard chunks. It knows nothing about the registry, cache, or IPC.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import type { Event } from '../base/event.js'
import type { AiResponse } from './aiModelService.js'
import type { AiMessage, AiModelMetadata, AiRequestOptions } from './aiModelTypes.js'

export interface IAiModelProvider {
  /** Fires when the provider's model list changes (e.g. a key was configured). */
  readonly onDidChange?: Event<void>

  /**
   * Which models this vendor currently offers. May depend on a configured API
   * key — return an empty list when no key is available.
   */
  provideModels(token: CancellationToken): Promise<readonly AiModelMetadata[]>

  /**
   * Execute one request. The provider:
   *  - reads its own key / baseUrl
   *  - translates AiMessage[] into the vendor HTTP body
   *  - translates the streamed response back into AiResponseChunk, yielding each
   *  - listens to `token.onCancellationRequested` to abort the network request
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse

  provideTokenCount(modelId: string, text: string, token: CancellationToken): Promise<number>
}
