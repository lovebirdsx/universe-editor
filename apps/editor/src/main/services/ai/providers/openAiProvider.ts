/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenAI provider — talks to the OpenAI Chat Completions API or any OpenAI-compatible
 *  endpoint (LM Studio, vLLM, DeepSeek, Together, …) via a configurable baseUrl.
 *  Models come from GET /models; chat streams Server-Sent Events from
 *  POST /chat/completions. The API key is read from encrypted secret storage and
 *  used only here in main; it never reaches the renderer or settings.json.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AiMessageRole,
  AsyncIterableSource,
  CancellationError,
  DeferredPromise,
  DisposableStore,
  Emitter,
  type Event,
  type AiMessage,
  type AiRequestOptions,
  type AiResponse,
  type AiRequestResult,
  type AiModelMetadata,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
} from '@universe-editor/platform'
import type { AiProviderContext } from '../aiModelMainService.js'
import { retryWithBackoff } from './retry.js'

const VENDOR = 'openai'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const SECRET_KEY = `ai.secret.${VENDOR}.apiKey`
// OpenAI exposes per-model context windows only out-of-band; use a safe default.
const DEFAULT_MAX_TOKENS = 8192

interface OpenAiModelEntry {
  readonly id: string
}

interface OpenAiChatStreamChunk {
  readonly choices?: ReadonlyArray<{ readonly delta?: { readonly content?: string } }>
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

export class OpenAiProvider implements IAiModelProvider {
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(private readonly _context: AiProviderContext) {}

  /** Call after the API key changes so the registry re-resolves the model list. */
  notifyConfigChanged(): void {
    this._onDidChange.fire()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  private get _baseUrl(): string {
    const configured = this._context.getVendorConfig(VENDOR)?.baseUrl?.trim()
    return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private _apiKey(): Promise<string | undefined> {
    return this._context.secrets.get(SECRET_KEY)
  }

  async provideModels(token: CancellationToken): Promise<readonly AiModelMetadata[]> {
    const apiKey = await this._apiKey()
    if (!apiKey) return []
    const signals = new DisposableStore()
    let res: Response
    try {
      res = await fetch(`${this._baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: toAbortSignal(token, signals),
      })
    } catch {
      // Endpoint unreachable — no models, not a hard error.
      return []
    } finally {
      signals.dispose()
    }
    if (!res.ok) return []
    const body = (await res.json()) as { data?: OpenAiModelEntry[] }
    const entries = body.data ?? []
    return entries.map((entry) => toMetadata(entry.id))
  }

  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
  ): AiResponse {
    const source = new AsyncIterableSource<AiResponseChunk>()
    const result = new DeferredPromise<AiRequestResult>()
    // A consumer may read only `stream`; keep result from surfacing unhandled.
    result.p.catch(() => undefined)

    void this._run(messages, options, token, source, result)
    return { stream: source.asyncIterable, result: result.p }
  }

  private async _run(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    token: CancellationToken,
    source: AsyncIterableSource<AiResponseChunk>,
    result: DeferredPromise<AiRequestResult>,
  ): Promise<void> {
    let usage: { inputTokens: number; outputTokens: number } | undefined
    const signals = new DisposableStore()
    try {
      const apiKey = await this._apiKey()
      if (!apiKey) {
        throw new AiError(AiErrorCode.ConfigurationRequired, 'OpenAI API key is not configured.')
      }

      const res = await retryWithBackoff(
        () =>
          fetch(`${this._baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(buildChatBody(toModelName(options.modelId), messages, options)),
            signal: toAbortSignal(token, signals),
          }),
        token,
        { isRetryable: isTransient },
      )

      if (!res.ok || !res.body) {
        throw mapHttpError(res.status, await safeText(res))
      }

      for await (const chunk of readSse(res.body, token)) {
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) source.emitOne({ type: 'text', value: delta })
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          }
        }
      }

      if (usage) source.emitOne({ type: 'usage', ...usage })
      source.resolve()
      result.complete(usage ? { usage } : {})
    } catch (err) {
      const error = normalizeError(err, token)
      source.reject(error)
      result.error(error)
    } finally {
      signals.dispose()
    }
  }

  async provideTokenCount(_modelId: string, text: string): Promise<number> {
    // No token-count endpoint; approximate ~4 chars/token like the Ollama provider.
    return Math.ceil(text.length / 4)
  }
}

function buildChatBody(
  model: string,
  messages: readonly AiMessage[],
  options: AiRequestOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: messages.map((m) => ({
      role: roleToString(m.role),
      content: m.content
        .filter((p): p is { type: 'text'; value: string } => p.type === 'text')
        .map((p) => p.value)
        .join(''),
    })),
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = [...options.stop]
  return { ...body, ...(options.extra ?? {}) }
}

function roleToString(role: AiMessageRole): string {
  switch (role) {
    case AiMessageRole.System:
      return 'system'
    case AiMessageRole.Assistant:
      return 'assistant'
    default:
      return 'user'
  }
}

function toMetadata(id: string): AiModelMetadata {
  return {
    id: `${VENDOR}/${id}`,
    vendor: VENDOR,
    name: id,
    family: id,
    maxInputTokens: DEFAULT_MAX_TOKENS,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    capabilities: { streaming: true },
  }
}

/** Strip the `openai/` prefix back to the bare model name the API expects. */
function toModelName(modelId: string): string {
  return modelId.startsWith(`${VENDOR}/`) ? modelId.slice(VENDOR.length + 1) : modelId
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  token: CancellationToken,
): AsyncGenerator<OpenAiChatStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (token.isCancellationRequested) throw new CancellationError()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        const data = parseSseData(rawLine)
        if (data === undefined) continue
        if (data === DONE) return
        yield JSON.parse(data) as OpenAiChatStreamChunk
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

const DONE = Symbol('sse-done')

/** Returns the JSON payload of a `data:` line, DONE on `[DONE]`, undefined to skip. */
function parseSseData(line: string): string | typeof DONE | undefined {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice('data:'.length).trim()
  if (!payload) return undefined
  if (payload === '[DONE]') return DONE
  return payload
}

function toAbortSignal(token: CancellationToken, store: DisposableStore): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else store.add(token.onCancellationRequested(() => controller.abort()))
  return controller.signal
}

function isTransient(err: unknown): boolean {
  if (err instanceof AiError) {
    return err.code === AiErrorCode.RateLimited || err.code === AiErrorCode.NetworkError
  }
  return false
}

function mapHttpError(status: number, detail: string): AiError {
  if (status === 401 || status === 403) {
    return new AiError(AiErrorCode.Unauthorized, `OpenAI unauthorized (${status}): ${detail}`)
  }
  if (status === 429) {
    return new AiError(AiErrorCode.RateLimited, `OpenAI rate limited (${status}): ${detail}`)
  }
  if (status >= 500) {
    return new AiError(AiErrorCode.NetworkError, `OpenAI server error (${status}): ${detail}`)
  }
  return new AiError(AiErrorCode.Unknown, `OpenAI request failed (${status}): ${detail}`)
}

function normalizeError(err: unknown, token: CancellationToken): unknown {
  if (token.isCancellationRequested || err instanceof CancellationError) {
    return new CancellationError()
  }
  if (err instanceof AiError) return err
  if (err instanceof Error && err.name === 'AbortError') return new CancellationError()
  return new AiError(AiErrorCode.NetworkError, err instanceof Error ? err.message : String(err))
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}
