/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side AI model facade. Wraps the main-process transport proxy: turns
 *  requestId-keyed chunk events back into a clean AsyncIterable (via
 *  AiResponseReassembler) and routes cancellation back to main. Provider
 *  instances, per-model config and the active model selections all live in
 *  aiSettings.json (read/written by main); this client just proxies. Consumers
 *  depend only on IAiModelService. Also implements IAiRateMirror for synchronous
 *  rate lookups on the cost hot path.
 *--------------------------------------------------------------------------------------------*/

import {
  AiResponseReassembler,
  combinedDisposable,
  Disposable,
  Emitter,
  generateUuid,
  reviveError,
  toDisposable,
  type AiAccountUsage,
  type AiMessage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiModelSelector,
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
  type AiProviderVerifyInput,
  type AiProviderVerifyResult,
  type AiRateTable,
  type AiRateTableSnapshot,
  type AiRequestOptions,
  type AiResponse,
  type CancellationToken,
  type Event,
  type IAiModelService,
} from '@universe-editor/platform'
import type {
  AiMessageDto,
  AiMessagePartDto,
  IAiModelMainService,
} from '../../../shared/ipc/aiModelService.js'
import { type IAiRateMirror } from './aiRateMirror.js'

export class AiModelClientService extends Disposable implements IAiModelService, IAiRateMirror {
  declare readonly _serviceBrand: undefined

  readonly onDidChangeModels: Event<void>
  readonly onDidChangeRemote: Event<void>

  private readonly _onDidChangeActiveModel = this._register(new Emitter<void>())
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event

  private readonly _onDidChangeInlineCompletionModel = this._register(new Emitter<void>())
  readonly onDidChangeInlineCompletionModel = this._onDidChangeInlineCompletionModel.event

  private readonly _onDidChangeCommitModel = this._register(new Emitter<void>())
  readonly onDidChangeCommitModel = this._onDidChangeCommitModel.event

  private readonly _onDidChangeSessionTitleModel = this._register(new Emitter<void>())
  readonly onDidChangeSessionTitleModel = this._onDidChangeSessionTitleModel.event

  private readonly _mirror = new Map<string, AiRateTableSnapshot>()

  constructor(private readonly _main: IAiModelMainService) {
    super()
    this.onDidChangeModels = this._main.onDidChangeModels
    this.onDidChangeRemote = this._main.onDidChangeRemote
    this._register(
      this._main.onDidChangeActiveModel((e) => {
        if (e.kind === 'chat') this._onDidChangeActiveModel.fire()
        else if (e.kind === 'inlineCompletion') this._onDidChangeInlineCompletionModel.fire()
        else if (e.kind === 'commit') this._onDidChangeCommitModel.fire()
        else this._onDidChangeSessionTitleModel.fire()
      }),
    )
    this._register(this._main.onDidChangeRemote(() => void this._refreshMirror()))
    void this._refreshMirror()
  }

  getRateTablesSync(): readonly AiRateTableSnapshot[] {
    return [...this._mirror.values()]
  }

  getRatesSync(providerKey: string): AiRateTable | undefined {
    return this._mirror.get(providerKey)?.rates
  }

  private async _refreshMirror(): Promise<void> {
    try {
      const tables = await this._main.getRateTables()
      this._mirror.clear()
      for (const table of tables) this._mirror.set(table.providerKey, table)
    } catch {
      // Best-effort mirror: keep whatever was last cached on failure.
    }
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

  getProviders(): Promise<readonly AiProviderInstance[]> {
    return this._main.getProviders()
  }

  updateProviders(providers: readonly AiProviderInstance[]): Promise<void> {
    return this._main.updateProviders(providers)
  }

  getProviderTypes(): Promise<Readonly<Record<string, AiProviderType>>> {
    return this._main.getProviderTypes()
  }

  updateProviderTypes(types: Readonly<Record<string, AiProviderType>>): Promise<void> {
    return this._main.updateProviderTypes(types)
  }

  getProviderTypeDescriptors(): Promise<readonly AiProviderTypeDescriptor[]> {
    return this._main.getProviderTypeDescriptors()
  }

  verifyProvider(input: AiProviderVerifyInput): Promise<AiProviderVerifyResult> {
    return this._main.verifyProvider(input)
  }

  setApiKey(typeId: string, instanceName: string, key: string): Promise<void> {
    return this._main.setApiKey(typeId, instanceName, key)
  }

  deleteApiKey(typeId: string, instanceName: string): Promise<void> {
    return this._main.deleteApiKey(typeId, instanceName)
  }

  hasApiKey(typeId: string, instanceName: string): Promise<boolean> {
    return this._main.hasApiKey(typeId, instanceName)
  }

  getRateTables(): Promise<readonly AiRateTableSnapshot[]> {
    return this._main.getRateTables()
  }

  getAccountUsage(providerKey: string): Promise<AiAccountUsage | undefined> {
    return this._main.getAccountUsage(providerKey)
  }

  refreshRemote(providerKey?: string): Promise<void> {
    return this._main.refreshRemote(providerKey)
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
    // Root the per-request subs under this service so a window reload with a
    // request still in flight is not flagged as a leak; on stream end the
    // reassembler disposes this wrapper, which also drops the entry from _store.
    const combined = this._register(combinedDisposable(subChunk, subEnd, subCancel))
    reassembler.bindSubscriptions(toDisposable(() => this._store.delete(combined)))

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
