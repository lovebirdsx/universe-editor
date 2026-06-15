/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side AI model facade. Wraps the main-process transport proxy: turns
 *  requestId-keyed chunk events back into a clean AsyncIterable (via
 *  AiResponseReassembler) and routes cancellation back to main. Provider groups &
 *  per-model config live in aiModels.json (read by main); the only renderer-owned
 *  state is the active model id (UI state in IStorageService). Consumers depend
 *  only on IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import {
  AiResponseReassembler,
  combinedDisposable,
  Disposable,
  Emitter,
  generateUuid,
  reviveError,
  StorageScope,
  type AiMessage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderGroup,
  type AiRequestOptions,
  type AiResponse,
  type CancellationToken,
  type IAiModelService,
  type IStorageService,
  type Event,
} from '@universe-editor/platform'
import type {
  AiMessageDto,
  AiMessagePartDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'

const ACTIVE_MODEL_KEY = 'ai.activeModelId'

export class AiModelClientService extends Disposable implements IAiModelService {
  declare readonly _serviceBrand: undefined

  readonly onDidChangeModels: Event<void>

  private readonly _onDidChangeActiveModel = this._register(new Emitter<void>())
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event

  constructor(
    private readonly _main: IAiModelMainService,
    private readonly _storage: IStorageService,
  ) {
    super()
    this.onDidChangeModels = this._main.onDidChangeModels
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

  getActiveModelId(): Promise<string | undefined> {
    return this._storage.get<string>(ACTIVE_MODEL_KEY, StorageScope.GLOBAL)
  }

  async setActiveModelId(modelId: string | undefined): Promise<void> {
    if (modelId === undefined) await this._storage.remove(ACTIVE_MODEL_KEY, StorageScope.GLOBAL)
    else await this._storage.set(ACTIVE_MODEL_KEY, modelId, StorageScope.GLOBAL)
    this._onDidChangeActiveModel.fire()
  }

  getModelConfiguration(modelId: string): Promise<AiModelConfiguration> {
    return this._main.getModelConfiguration(modelId)
  }

  setModelConfiguration(modelId: string, config: AiModelConfiguration): Promise<void> {
    return this._main.setModelConfiguration(modelId, config)
  }

  getGroups(): Promise<readonly AiProviderGroup[]> {
    return this._main.getGroups()
  }

  updateGroups(groups: readonly AiProviderGroup[]): Promise<void> {
    return this._main.updateGroups(groups)
  }

  setApiKey(vendor: string, group: string, key: string): Promise<void> {
    return this._main.setApiKey(vendor, group, key)
  }

  deleteApiKey(vendor: string, group: string): Promise<void> {
    return this._main.deleteApiKey(vendor, group)
  }

  hasApiKey(vendor: string, group: string): Promise<boolean> {
    return this._main.hasApiKey(vendor, group)
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
