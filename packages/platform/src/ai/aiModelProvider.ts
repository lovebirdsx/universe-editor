/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider contract: one implementation per wire protocol. A provider
 *  translates a standardized request into that protocol's HTTP API and its
 *  response back into standard chunks. It knows nothing about the registry,
 *  cache, model knowledge, or IPC.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import type { AiProviderRuntime } from './aiProviderEntry.js'
import type { AiResponse } from './aiModelService.js'
import type { AiMessage, AiRequestOptions } from './aiModelTypes.js'

export interface IAiModelProvider {
  /**
   * Enumerate the wire model names this endpoint currently offers. Only called
   * for a protocol the user declared as `[]` (discover from endpoint); when the
   * entry lists models explicitly, the registry uses that list verbatim and this
   * is never called. Returns an empty list when the endpoint needs a key it does
   * not have. Metadata is the registry's job, not the provider's.
   */
  listModels(provider: AiProviderRuntime, token: CancellationToken): Promise<readonly string[]>

  /**
   * Execute one request against `provider`. The provider:
   *  - reads the entry's apiKey / baseUrl
   *  - translates AiMessage[] into the protocol HTTP body
   *  - translates the streamed response back into AiResponseChunk, yielding each
   *  - listens to `token.onCancellationRequested` to abort the network request
   */
  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): AiResponse

  provideTokenCount(
    modelId: string,
    text: string,
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): Promise<number>
}
