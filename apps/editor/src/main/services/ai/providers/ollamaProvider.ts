/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Ollama provider — talks to a local Ollama server (no API key needed, ideal for
 *  end-to-end verification). Models come from /api/tags; chat streams NDJSON from
 *  /api/chat. Translates the standard request/response shapes to/from Ollama's.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AiMessageRole,
  AsyncIterableSource,
  CancellationError,
  DeferredPromise,
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

const VENDOR = 'ollama'
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
// Ollama exposes no per-model token window via the API; use a conservative default.
const DEFAULT_MAX_TOKENS = 4096

interface OllamaTag {
  readonly name: string
  readonly model?: string
}

interface OllamaChatStreamLine {
  readonly message?: { readonly role?: string; readonly content?: string }
  readonly done?: boolean
  readonly prompt_eval_count?: number
  readonly eval_count?: number
}

export class OllamaProvider implements IAiModelProvider {
  constructor(private readonly _context: AiProviderContext) {}

  private get _baseUrl(): string {
    return this._context.getVendorConfig(VENDOR)?.baseUrl?.replace(/\/+$/, '') ?? DEFAULT_BASE_URL
  }

  async provideModels(token: CancellationToken): Promise<readonly AiModelMetadata[]> {
    let res: Response
    try {
      res = await fetch(`${this._baseUrl}/api/tags`, { signal: toAbortSignal(token) })
    } catch {
      // Server not running / unreachable — no models, not a hard error.
      return []
    }
    if (!res.ok) return []
    const body = (await res.json()) as { models?: OllamaTag[] }
    const tags = body.models ?? []
    return tags.map((tag) => toMetadata(tag.name))
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
    try {
      const res = await retryWithBackoff(
        () =>
          fetch(`${this._baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildChatBody(toModelName(options.modelId), messages, options)),
            signal: toAbortSignal(token),
          }),
        token,
        { isRetryable: isTransient },
      )

      if (!res.ok || !res.body) {
        throw mapHttpError(res.status, await safeText(res))
      }

      for await (const line of readNdjson(res.body, token)) {
        if (line.message?.content) {
          source.emitOne({ type: 'text', value: line.message.content })
        }
        if (line.done) {
          usage = {
            inputTokens: line.prompt_eval_count ?? 0,
            outputTokens: line.eval_count ?? 0,
          }
          source.emitOne({ type: 'usage', ...usage })
        }
      }

      source.resolve()
      result.complete(usage ? { usage } : {})
    } catch (err) {
      const error = normalizeError(err, token)
      source.reject(error)
      result.error(error)
    }
  }

  async provideTokenCount(_modelId: string, text: string): Promise<number> {
    // Ollama has no token-count endpoint; approximate ~4 chars/token.
    return Math.ceil(text.length / 4)
  }
}

function buildChatBody(
  model: string,
  messages: readonly AiMessage[],
  options: AiRequestOptions,
): Record<string, unknown> {
  const ollamaOptions: Record<string, unknown> = {}
  if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature
  if (options.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens
  if (options.stop !== undefined) ollamaOptions.stop = [...options.stop]
  return {
    model,
    stream: true,
    messages: messages.map((m) => ({
      role: roleToString(m.role),
      content: m.content
        .filter((p): p is { type: 'text'; value: string } => p.type === 'text')
        .map((p) => p.value)
        .join(''),
    })),
    options: ollamaOptions,
    ...(options.extra ?? {}),
  }
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

function toMetadata(name: string): AiModelMetadata {
  return {
    id: `${VENDOR}/${name}`,
    vendor: VENDOR,
    name,
    family: name.split(':')[0] ?? name,
    maxInputTokens: DEFAULT_MAX_TOKENS,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    capabilities: { streaming: true },
  }
}

/** Strip the `ollama/` prefix back to the bare model name Ollama expects. */
function toModelName(modelId: string): string {
  return modelId.startsWith(`${VENDOR}/`) ? modelId.slice(VENDOR.length + 1) : modelId
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  token: CancellationToken,
): AsyncGenerator<OllamaChatStreamLine> {
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
        if (rawLine) yield JSON.parse(rawLine) as OllamaChatStreamLine
      }
    }
    const tail = buffer.trim()
    if (tail) yield JSON.parse(tail) as OllamaChatStreamLine
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

function toAbortSignal(token: CancellationToken): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else token.onCancellationRequested(() => controller.abort())
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
    return new AiError(AiErrorCode.Unauthorized, `Ollama unauthorized (${status}): ${detail}`)
  }
  if (status === 429) {
    return new AiError(AiErrorCode.RateLimited, `Ollama rate limited (${status}): ${detail}`)
  }
  if (status >= 500) {
    return new AiError(AiErrorCode.NetworkError, `Ollama server error (${status}): ${detail}`)
  }
  return new AiError(AiErrorCode.Unknown, `Ollama request failed (${status}): ${detail}`)
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
