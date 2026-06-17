/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the trusted host's `mainThreadAi` channel. Wraps the
 *  renderer's IAiModelService (itself a facade over the main process), pumping
 *  each request's clean AsyncIterable back into requestId-keyed chunk/end events
 *  the host reassembles. Cancellation is routed by requestId. Mirrors the way
 *  AiModelMainService bridges main→renderer, one boundary further out.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  Emitter,
  transformErrorForSerialization,
  type AiMessage,
  type AiModelMetadata,
  type AiModelSelector,
  type AiRequestOptions,
  type IAiModelService,
} from '@universe-editor/platform'
import type {
  AiChunkEventDto,
  AiEndEventDto,
  AiMessageDto,
  IMainThreadAi,
} from '@universe-editor/extensions-common'

export class MainThreadAi extends Disposable implements IMainThreadAi {
  private readonly _onDidEmitChunk = this._register(new Emitter<AiChunkEventDto>())
  readonly onDidEmitChunk = this._onDidEmitChunk.event

  private readonly _onDidEndRequest = this._register(new Emitter<AiEndEventDto>())
  readonly onDidEndRequest = this._onDidEndRequest.event

  private readonly _inflight = new Map<string, CancellationTokenSource>()

  constructor(private readonly _ai: IAiModelService) {
    super()
  }

  getModels(): Promise<readonly AiModelMetadata[]> {
    return this._ai.getModels()
  }

  selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    return this._ai.selectModels(selector)
  }

  computeTokenLength(modelId: string, text: string): Promise<number> {
    const cts = new CancellationTokenSource()
    return this._ai.computeTokenLength(modelId, text, cts.token).finally(() => cts.dispose())
  }

  getActiveModelId(): Promise<string | undefined> {
    return this._ai.getActiveModelId()
  }

  getCommitModelId(): Promise<string | undefined> {
    return this._ai.getCommitModelId()
  }

  async startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void> {
    const cts = new CancellationTokenSource()
    this._inflight.set(requestId, cts)

    let response: ReturnType<IAiModelService['sendRequest']>
    try {
      response = this._ai.sendRequest(messages.map(reviveMessage), options, cts.token)
    } catch (err) {
      this._onDidEndRequest.fire({ requestId, error: transformErrorForSerialization(err) })
      this._disposeInflight(requestId)
      return
    }

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
        this._disposeInflight(requestId)
      }
    })()
  }

  async cancelRequest(requestId: string): Promise<void> {
    this._inflight.get(requestId)?.cancel()
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

function reviveMessage(dto: AiMessageDto): AiMessage {
  return {
    role: dto.role,
    content: dto.content.map((part) => ({ type: 'text', value: part.value })),
  }
}
