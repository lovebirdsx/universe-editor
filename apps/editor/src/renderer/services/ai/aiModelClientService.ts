/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side AI model facade. Wraps the main-process transport proxy: turns
 *  requestId-keyed chunk events back into a clean AsyncIterable (via
 *  AiResponseReassembler), routes cancellation back to main, and pushes the
 *  resolved non-secret config (schema default + user settings) down to main so
 *  providers can read baseUrl / defaults. Consumers depend only on IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import {
  AiResponseReassembler,
  combinedDisposable,
  Disposable,
  generateUuid,
  reviveError,
  type AiMessage,
  type AiModelMetadata,
  type AiModelSelector,
  type AiRequestOptions,
  type AiResponse,
  type CancellationToken,
  type IAiModelService,
  type IConfigurationService,
  type Event,
} from '@universe-editor/platform'
import type {
  AiMessageDto,
  AiMessagePartDto,
  AiResolvedConfigDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'

/** Vendors whose config the renderer mirrors to main. Extend as providers land. */
const KNOWN_VENDORS = ['ollama', 'openai'] as const

/** Exact ai.* keys we read; the platform's affectsConfiguration is exact-match. */
const CONFIG_KEYS = [
  ...KNOWN_VENDORS.flatMap((v) => [`ai.${v}.baseUrl`, `ai.${v}.defaultModel`]),
  'ai.request.temperature',
  'ai.request.maxTokens',
]

export class AiModelClientService extends Disposable implements IAiModelService {
  declare readonly _serviceBrand: undefined

  readonly onDidChangeModels: Event<void>

  constructor(
    private readonly _main: IAiModelMainService,
    private readonly _configuration: IConfigurationService,
  ) {
    super()
    this.onDidChangeModels = this._main.onDidChangeModels

    // Push config now and whenever any ai.* setting we read changes, so main-side
    // providers always see the merged (schema default → user) non-secret config.
    void this._pushConfig()
    this._register(
      this._configuration.onDidChangeConfiguration((e) => {
        if (CONFIG_KEYS.some((key) => e.affectsConfiguration(key))) void this._pushConfig()
      }),
    )
  }

  getModels(): Promise<readonly AiModelMetadata[]> {
    return this._main.getModels()
  }

  selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    return this._main.selectModels(selector)
  }

  computeTokenLength(modelId: string, text: string): Promise<number> {
    return this._main.computeTokenLength(modelId, text)
  }

  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse {
    const requestId = generateUuid()
    const reassembler = new AiResponseReassembler()

    const subChunk = this._main.onDidEmitChunk((e) => {
      if (e.requestId === requestId) reassembler.acceptChunk(e.chunk)
    })
    const subEnd = this._main.onDidEndRequest((e) => {
      if (e.requestId !== requestId) return
      reassembler.acceptEnd(e.error ? reviveError(e.error) : undefined)
    })
    const subCancel = token.onCancellationRequested(() => {
      void this._main.cancelRequest(requestId)
    })
    reassembler.bindSubscriptions(combinedDisposable(subChunk, subEnd, subCancel))

    void this._main.startRequest(requestId, messages.map(toMessageDto), options).catch((err) => {
      reassembler.acceptEnd(err)
    })

    return reassembler.response
  }

  private async _pushConfig(): Promise<void> {
    const vendors: Record<string, { baseUrl?: string; defaultModel?: string }> = {}
    for (const vendor of KNOWN_VENDORS) {
      const baseUrl = this._configuration.get<string>(`ai.${vendor}.baseUrl`)
      const defaultModel = this._configuration.get<string>(`ai.${vendor}.defaultModel`)
      const entry: { baseUrl?: string; defaultModel?: string } = {}
      if (baseUrl !== undefined) entry.baseUrl = baseUrl
      if (defaultModel !== undefined) entry.defaultModel = defaultModel
      vendors[vendor] = entry
    }
    const request: { temperature?: number; maxTokens?: number } = {}
    const temperature = this._configuration.get<number>('ai.request.temperature')
    const maxTokens = this._configuration.get<number>('ai.request.maxTokens')
    if (temperature !== undefined) request.temperature = temperature
    if (maxTokens !== undefined) request.maxTokens = maxTokens

    const config: AiResolvedConfigDto = { vendors, request }
    await this._main.setConfig(config)
  }
}

function toMessageDto(message: AiMessage): AiMessageDto {
  return {
    role: message.role,
    content: message.content.map((part): AiMessagePartDto => {
      if (part.type === 'image') {
        return {
          type: 'image',
          mimeType: part.mimeType,
          dataBase64: bytesToBase64(part.data),
        }
      }
      return part
    }),
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
