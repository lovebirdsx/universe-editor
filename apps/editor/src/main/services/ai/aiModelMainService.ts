/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process AI model facade: holds the provider registry, schedules requests,
 *  pumps each provider stream into requestId-keyed chunk events, and routes
 *  cancellation back to the provider. Three-layer config merge (schema default →
 *  user settings → per-request options) collapses here in _mergeConfig.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
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
  type AiResponse,
  type IAiModelProvider,
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
import { OpenAiProvider } from './providers/openAiProvider.js'

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
  private readonly _secrets: ISecretStorageService
  private readonly _keyedProviders = new Map<string, { notifyConfigChanged(): void }>()

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
    this._secrets = secrets

    const context: AiProviderContext = {
      secrets,
      getVendorConfig: (vendor) => this._config.vendors[vendor],
      getRequestDefaults: () => this._config.request,
    }
    this._registerBuiltInProviders(context)
  }

  private _registerBuiltInProviders(context: AiProviderContext): void {
    this._register(this._registry.registerProvider('ollama', new OllamaProvider(context)))
    const openai = new OpenAiProvider(context)
    this._keyedProviders.set('openai', openai)
    this._register(this._registry.registerProvider('openai', openai))
  }

  getModels(): Promise<readonly AiModelMetadata[]> {
    return this._withTimeoutToken((token) => this._registry.getModels(token))
  }

  selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    return this._withTimeoutToken((token) => this._registry.selectModels(selector, token))
  }

  async computeTokenLength(modelId: string, text: string): Promise<number> {
    return this._withTimeoutToken(async (token) => {
      const provider = await this._providerForModelId(modelId, token)
      if (!provider) throw missingProviderError(modelId)
      return provider.provideTokenCount(modelId, text, token)
    })
  }

  async setConfig(config: AiResolvedConfigDto): Promise<void> {
    this._config = config
  }

  async setApiKey(vendor: string, key: string): Promise<void> {
    await this._secrets.set(secretKey(vendor), key)
    this._keyedProviders.get(vendor)?.notifyConfigChanged()
  }

  async deleteApiKey(vendor: string): Promise<void> {
    await this._secrets.delete(secretKey(vendor))
    this._keyedProviders.get(vendor)?.notifyConfigChanged()
  }

  async hasApiKey(vendor: string): Promise<boolean> {
    return (await this._secrets.get(secretKey(vendor))) !== undefined
  }

  async startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void> {
    const cts = new CancellationTokenSource()
    this._inflight.set(requestId, cts)

    try {
      const provider = await this._providerForModelId(options.modelId, cts.token)
      if (!provider) {
        this._endRequestWithError(requestId, missingProviderError(options.modelId))
        this._disposeInflight(requestId)
        return
      }

      const domainMessages = messages.map(reviveMessage)
      const merged = this._mergeConfig(options)
      this._pumpResponse(requestId, provider.sendRequest(domainMessages, merged, cts.token))
    } catch (err) {
      this._endRequestWithError(requestId, err)
      this._disposeInflight(requestId)
    }
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

  private _providerForModelId(
    modelId: string,
    token: CancellationToken,
  ): Promise<IAiModelProvider | undefined> {
    const vendor = vendorFromModelId(modelId)
    if (vendor !== undefined) {
      return Promise.resolve(this._registry.getProvider(vendor))
    }
    return this._registry.providerForModel(modelId, token)
  }

  private _pumpResponse(requestId: string, response: AiResponse): void {
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
        this._endRequestWithError(requestId, err)
      } finally {
        this._disposeInflight(requestId)
      }
    })()
  }

  private _endRequestWithError(requestId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this._logger.warn(`request ${requestId} failed: ${message}`)
    this._onDidEndRequest.fire({ requestId, error: transformErrorForSerialization(error) })
  }

  private _disposeInflight(requestId: string): void {
    this._inflight.get(requestId)?.dispose()
    this._inflight.delete(requestId)
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

/** Secret-storage key holding a vendor's API key, e.g. `ai.secret.openai.apiKey`. */
function secretKey(vendor: string): string {
  return `ai.secret.${vendor}.apiKey`
}

function vendorFromModelId(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : undefined
}

function missingProviderError(modelId: string): AiError {
  const vendor = vendorFromModelId(modelId)
  if (vendor !== undefined) {
    return new AiError(
      AiErrorCode.ProviderUnavailable,
      `AI provider '${vendor}' is not available for model '${modelId}'.`,
    )
  }
  return new AiError(AiErrorCode.ModelNotFound, `No AI model provider found for '${modelId}'.`)
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
