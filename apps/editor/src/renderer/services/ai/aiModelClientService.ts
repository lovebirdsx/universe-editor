/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side AI model facade. Wraps the main-process transport proxy: turns
 *  requestId-keyed chunk events back into a clean AsyncIterable (via
 *  AiResponseReassembler) and routes cancellation back to main. Provider groups,
 *  per-model config and the active model selections all live in aiSettings.json
 *  (read/written by main); this client just proxies. Consumers depend only on
 *  IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import {
  AiResponseReassembler,
  combinedDisposable,
  Disposable,
  Emitter,
  generateUuid,
  reviveError,
  type AiGroupVerifyInput,
  type AiGroupVerifyResult,
  type AiMessage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderGroup,
  type AiRequestOptions,
  type AiResponse,
  type AiVendorDescriptor,
  type CancellationToken,
  type IAiModelService,
  type Event,
} from '@universe-editor/platform'
import type {
  AiMessageDto,
  AiMessagePartDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'

export class AiModelClientService extends Disposable implements IAiModelService {
  declare readonly _serviceBrand: undefined

  readonly onDidChangeModels: Event<void>

  private readonly _onDidChangeActiveModel = this._register(new Emitter<void>())
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event

  private readonly _onDidChangeInlineCompletionModel = this._register(new Emitter<void>())
  readonly onDidChangeInlineCompletionModel = this._onDidChangeInlineCompletionModel.event

  private readonly _onDidChangeCommitModel = this._register(new Emitter<void>())
  readonly onDidChangeCommitModel = this._onDidChangeCommitModel.event

  private readonly _onDidChangeSessionTitleModel = this._register(new Emitter<void>())
  readonly onDidChangeSessionTitleModel = this._onDidChangeSessionTitleModel.event

  constructor(private readonly _main: IAiModelMainService) {
    super()
    this.onDidChangeModels = this._main.onDidChangeModels
    this._register(
      this._main.onDidChangeActiveModel((e) => {
        if (e.kind === 'chat') this._onDidChangeActiveModel.fire()
        else if (e.kind === 'inlineCompletion') this._onDidChangeInlineCompletionModel.fire()
        else if (e.kind === 'commit') this._onDidChangeCommitModel.fire()
        else this._onDidChangeSessionTitleModel.fire()
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

  getActiveModelId(): Promise<string | undefined> {
    return this._main.getActiveModel('chat')
  }

  setActiveModelId(modelId: string | undefined): Promise<void> {
    return this._main.setActiveModel('chat', modelId)
  }

  getInlineCompletionModelId(): Promise<string | undefined> {
    return this._main.getActiveModel('inlineCompletion')
  }

  setInlineCompletionModelId(modelId: string | undefined): Promise<void> {
    return this._main.setActiveModel('inlineCompletion', modelId)
  }

  getCommitModelId(): Promise<string | undefined> {
    return this._main.getActiveModel('commit')
  }

  setCommitModelId(modelId: string | undefined): Promise<void> {
    return this._main.setActiveModel('commit', modelId)
  }

  getSessionTitleModelId(): Promise<string | undefined> {
    return this._main.getActiveModel('sessionTitle')
  }

  setSessionTitleModelId(modelId: string | undefined): Promise<void> {
    return this._main.setActiveModel('sessionTitle', modelId)
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

  getVendors(): Promise<readonly AiVendorDescriptor[]> {
    return this._main.getVendors()
  }

  verifyGroup(input: AiGroupVerifyInput): Promise<AiGroupVerifyResult> {
    return this._main.verifyGroup(input)
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
