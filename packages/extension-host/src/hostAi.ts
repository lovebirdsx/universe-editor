/**
 * Host-side AI handle backing the `ai` namespace. Wraps the renderer's
 * `mainThreadAi` proxy: turns requestId-keyed chunk/end events back into a clean
 * AsyncIterable (via the platform's AiResponseReassembler), and routes
 * cancellation by requestId. The reassembly mirrors the renderer's own
 * AiModelClientService, one RPC boundary further out.
 */
import {
  AiResponseReassembler,
  combinedDisposable,
  generateUuid,
  reviveError,
} from '@universe-editor/platform'
import type { AiMessageDto, IMainThreadAi } from '@universe-editor/extensions-common'
import type {
  AiApi,
  AiMessage,
  AiModelMetadata,
  AiModelSelector,
  AiRequestOptions,
  AiResponse,
} from '@universe-editor/extension-api'

export class HostAi implements AiApi {
  constructor(private readonly _ai: IMainThreadAi) {}

  getModels(): Promise<readonly AiModelMetadata[]> {
    return this._ai.getModels() as Promise<readonly AiModelMetadata[]>
  }

  selectModels(selector: AiModelSelector): Promise<readonly string[]> {
    return this._ai.selectModels(selector)
  }

  computeTokenLength(modelId: string, text: string): Promise<number> {
    return this._ai.computeTokenLength(modelId, text)
  }

  getActiveModelId(): Promise<string | undefined> {
    return this._ai.getActiveModelId()
  }

  getCommitModelId(): Promise<string | undefined> {
    return this._ai.getCommitModelId()
  }

  getCommitSystemPrompt(): Promise<string | undefined> {
    return this._ai.getCommitSystemPrompt()
  }

  sendRequest(messages: readonly AiMessage[], options: AiRequestOptions): AiResponse {
    const requestId = generateUuid()
    const reassembler = new AiResponseReassembler()

    const subChunk = this._ai.onDidEmitChunk((e) => {
      if (e.requestId === requestId) reassembler.acceptChunk(e.chunk)
    })
    const subEnd = this._ai.onDidEndRequest((e) => {
      if (e.requestId !== requestId) return
      reassembler.acceptEnd(e.error ? reviveError(e.error) : undefined)
    })
    reassembler.bindSubscriptions(combinedDisposable(subChunk, subEnd))

    void this._ai
      .startRequest(requestId, messages.map(toMessageDto), options)
      .catch((err: unknown) => reassembler.acceptEnd(err))

    const response = reassembler.response
    return {
      stream: response.stream,
      result: response.result.then(() => undefined),
      cancel: () => {
        void this._ai.cancelRequest(requestId)
      },
    }
  }
}

function toMessageDto(message: AiMessage): AiMessageDto {
  // Both AiMessageRole enums (extension-api / platform) share numeric values.
  return {
    role: message.role as unknown as AiMessageDto['role'],
    content: [{ type: 'text', value: message.content }],
  }
}
