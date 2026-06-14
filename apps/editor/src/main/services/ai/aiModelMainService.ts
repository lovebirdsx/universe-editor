/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: holds the provider registry, schedules requests,
 *  pumps each provider stream into requestId-keyed chunk events, and routes
 *  cancellation back to the provider. Three-layer config merge (schema default →
 *  user settings → per-request options) collapses here in _mergeConfig.
 *--------------------------------------------------------------------------------------------*/

import {
  AiModelRegistry,
  type CancellationToken,
  CancellationTokenSource,
  createNamedLogger,
  Disposable,
  Emitter,
  type ILogger,
  ILoggerService,
  ISecretStorageService,
  transformErrorForSerialization,
  type AiMessage,
  type AiMessagePart,
  type AiModelMetadata,
  type AiModelSelector,
  type AiRequestOptions,
} from '@universe-editor/platform'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
  AiResolvedConfigDto,
  AiVendorConfigDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'
import { OllamaProvider } from './providers/ollamaProvider.js'

/** What a provider may read from its host: resolved config + secret access. */
export interface AiProviderContext {
  readonly secrets: ISecretStorageService
  getVendorConfig(vendor: string): AiVendorConfigDto | undefined
  getRequestDefaults(): AiResolvedConfigDto['request']
}

const EMPTY_CONFIG: AiResolvedConfigDto = { vendors: {}, request: {} }

export class AiModelMainService extends Disposable implements IAiModelMainService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _registry = this._register(new AiModelRegistry())

  private readonly _onDidEmitChunk = this._register(new Emitter<AiChunkEvent>())
  readonly onDidEmitChunk = this._onDidEmitChunk.event

  private readonly _onDidEndRequest = this._register(new Emitter<AiEndEvent>())
  readonly onDidEndRequest = this._onDidEndRequest.event

  readonly onDidChangeModels = this._registry.onDidChangeModels

  private readonly _inflight = new Map<string, CancellationTokenSource>()
  private _config: AiResolvedConfigDto = EMPTY_CONFIG

  constructor(
    @ISecretStorageService secrets: ISecretStorageService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'aiModel', name: 'AI Model' })

    const context: AiProviderContext = {
      secrets,
      getVendorConfig: (vendor) => this._config.vendors[vendor],
      getRequestDefaults: () => this._config.request,
    }
    this._registerBuiltInProviders(context)
  }

  private _registerBuiltInProviders(context: AiProviderContext): void {
    this._register(this._registry.registerProvider('ollama', new OllamaProvider(context)))
  }

  getModels(): Promise<readonly AiModelMetadata[]> {
    return this._withTimeoutToken((token) => this._registry.getModels(token))
  }

  selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    return this._withTimeoutToken((token) => this._registry.selectModels(selector, token))
  }

  async computeTokenLength(modelId: string, text: string): Promise<number> {
    return this._withTimeoutToken(async (token) => {
      const provider = await this._registry.providerForModel(modelId, token)
      if (!provider) throw new Error(`No provider found for model '${modelId}'`)
      return provider.provideTokenCount(modelId, text, token)
    })
  }

  async setConfig(config: AiResolvedConfigDto): Promise<void> {
    this._config = config
  }

  async startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void> {
    const cts = new CancellationTokenSource()
    this._inflight.set(requestId, cts)

    const provider = await this._registry.providerForModel(options.modelId, cts.token)
    if (!provider) {
      this._inflight.delete(requestId)
      cts.dispose()
      this._onDidEndRequest.fire({
        requestId,
        error: transformErrorForSerialization(
          new Error(`No provider found for model '${options.modelId}'`),
        ),
      })
      return
    }

    const domainMessages = messages.map(reviveMessage)
    const merged = this._mergeConfig(options)
    const response = provider.sendRequest(domainMessages, merged, cts.token)

    // Pump the provider's stream into requestId-keyed events. Errors and normal
    // completion both terminate via onDidEndRequest (two-path on the renderer).
    void (async () => {
      try {
        for await (const chunk of response.stream) {
          this._onDidEmitChunk.fire({ requestId, chunk })
        }
        await response.result
        this._onDidEndRequest.fire({ requestId })
      } catch (err) {
        this._onDidEndRequest.fire({ requestId, error: transformErrorForSerialization(err) })
      } finally {
        this._inflight.get(requestId)?.dispose()
        this._inflight.delete(requestId)
      }
    })()
  }

  async cancelRequest(requestId: string): Promise<void> {
    this._inflight.get(requestId)?.cancel()
  }

  /** schema default / user settings (already merged in `_config`) → per-request. */
  private _mergeConfig(options: AiRequestOptions): AiRequestOptions {
    const defaults = this._config.request
    const merged = {
      ...options,
      temperature: options.temperature ?? defaults.temperature,
      maxTokens: options.maxTokens ?? defaults.maxTokens,
    }
    // Drop keys left undefined so exactOptionalPropertyTypes stays satisfied.
    return stripUndefined(merged)
  }

  private async _withTimeoutToken<T>(fn: (token: CancellationToken) => Promise<T>): Promise<T> {
    const cts = new CancellationTokenSource()
    try {
      return await fn(cts.token)
    } finally {
      cts.dispose()
    }
  }

  override dispose(): void {
    for (const cts of this._inflight.values()) {
      cts.cancel()
      cts.dispose()
    }
    this._inflight.clear()
    super.dispose()
  }
}

function reviveMessage(dto: AiMessageDto): AiMessage {
  return {
    role: dto.role,
    content: dto.content.map((part): AiMessagePart => {
      if (part.type === 'image') {
        return {
          type: 'image',
          mimeType: part.mimeType,
          data: Uint8Array.from(Buffer.from(part.dataBase64, 'base64')),
        }
      }
      return part
    }),
  }
}

function stripUndefined(options: Record<string, unknown>): AiRequestOptions {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) out[k] = v
  }
  return out as unknown as AiRequestOptions
}
