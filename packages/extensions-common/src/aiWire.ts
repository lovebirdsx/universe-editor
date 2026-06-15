/**
 * Wire contract for the AI model service exposed to the trusted extension host.
 * The renderer hosts `mainThreadAi` on its ChannelServer; the trusted host calls
 * it. Streaming crosses the boundary as discrete chunk events keyed by requestId
 * (the framing can't carry an AsyncIterable), exactly mirroring the main↔renderer
 * `IAiModelMainService`. Restricted hosts never get this channel.
 */
import type {
  AiModelMetadata,
  AiModelSelector,
  AiRequestOptions,
  AiResponseChunk,
  AiMessageRole,
  Event,
  SerializedError,
} from '@universe-editor/platform'

/** A message part on the wire. Text only for now (vision lands when needed). */
export interface AiMessagePartDto {
  readonly type: 'text'
  readonly value: string
}

export interface AiMessageDto {
  readonly role: AiMessageRole
  readonly content: readonly AiMessagePartDto[]
}

/** A streamed chunk tagged with the request it belongs to. */
export interface AiChunkEventDto {
  readonly requestId: string
  readonly chunk: AiResponseChunk
}

/** End-of-request signal; `error` present iff the request failed. */
export interface AiEndEventDto {
  readonly requestId: string
  readonly error?: SerializedError
}

/**
 * Renderer → exposed to the trusted ext host: AI model requests. `on*` props are
 * bridged to `listen` by ProxyChannel; everything else is a `call`. Mirrors the
 * main-process `IAiModelMainService`, minus the renderer-only config push.
 */
export interface IMainThreadAi {
  readonly onDidEmitChunk: Event<AiChunkEventDto>
  readonly onDidEndRequest: Event<AiEndEventDto>

  getModels(): Promise<readonly AiModelMetadata[]>
  selectModels(selector: AiModelSelector): Promise<readonly string[]>
  computeTokenLength(modelId: string, text: string): Promise<number>

  /** The user's currently selected model id (UI state), if any. */
  getActiveModelId(): Promise<string | undefined>

  /** Fire a request; chunks/end come back via the events keyed by `requestId`. */
  startRequest(
    requestId: string,
    messages: readonly AiMessageDto[],
    options: AiRequestOptions,
  ): Promise<void>
  /** Cancel an in-flight request — aborts the underlying network call in main. */
  cancelRequest(requestId: string): Promise<void>
}
