/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Ollama provider — speaks the `ollama` wire protocol against a local Ollama server
 *  (no API key needed, ideal for end-to-end verification). Models come from /api/tags;
 *  chat streams NDJSON from /api/chat. Translates the standard request/response shapes
 *  to/from Ollama's.
 *--------------------------------------------------------------------------------------------*/

import {
  AiError,
  AiErrorCode,
  AiMessageRole,
  AsyncIterableSource,
  bareModelName,
  CancellationError,
  DeferredPromise,
  DisposableStore,
  type AiMessage,
  type AiRequestOptions,
  type AiProviderRuntime,
  type AiResponse,
  type AiRequestResult,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
  localize,
} from '@universe-editor/platform'
import {
  modelsEndpointError,
  modelsNetworkError,
  retryWithBackoff,
  toAbortSignal,
} from './retry.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

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
  async listModels(
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const signals = new DisposableStore()
    let res: Response
    try {
      res = await fetch(`${baseUrl(provider)}/api/tags`, { signal: toAbortSignal(token, signals) })
    } catch (err) {
      throw modelsNetworkError(err, token)
    } finally {
      signals.dispose()
    }
    if (!res.ok) throw modelsEndpointError(res.status)
    return (((await res.json()) as { models?: OllamaTag[] }).models ?? []).map((tag) => tag.name)
  }

  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): AiResponse {
    const source = new AsyncIterableSource<AiResponseChunk>()
    const result = new DeferredPromise<AiRequestResult>()
    // A consumer may read only `stream`; keep result from surfacing unhandled.
    result.p.catch(() => undefined)

    void this._run(messages, options, provider, token, source, result)
    return { stream: source.asyncIterable, result: result.p }
  }

  private async _run(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    provider: AiProviderRuntime,
    token: CancellationToken,
    source: AsyncIterableSource<AiResponseChunk>,
    result: DeferredPromise<AiRequestResult>,
  ): Promise<void> {
    let usage: { inputTokens: number; outputTokens: number } | undefined
    const signals = new DisposableStore()
    try {
      const res = await retryWithBackoff(
        () =>
          fetch(`${baseUrl(provider)}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              buildChatBody(
                bareModelName(options.modelId, provider.id, provider.protocol),
                messages,
                options,
              ),
            ),
            signal: toAbortSignal(token, signals),
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
    } finally {
      signals.dispose()
    }
  }

  async provideTokenCount(_modelId: string, text: string): Promise<number> {
    // Ollama has no token-count endpoint; approximate ~4 chars/token.
    return Math.ceil(text.length / 4)
  }
}

function baseUrl(provider: AiProviderRuntime): string {
  return (provider.baseUrl?.replace(/\/+$/, '') || DEFAULT_BASE_URL).replace(/\/+$/, '')
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

function isTransient(err: unknown): boolean {
  if (err instanceof AiError) {
    return err.code === AiErrorCode.RateLimited || err.code === AiErrorCode.NetworkError
  }
  return false
}

function mapHttpError(status: number, detail: string): AiError {
  if (status === 401 || status === 403) {
    return new AiError(
      AiErrorCode.Unauthorized,
      localize('ai.error.ollama.unauthorized', 'Ollama unauthorized ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status === 429) {
    return new AiError(
      AiErrorCode.RateLimited,
      localize('ai.error.ollama.rateLimited', 'Ollama rate limited ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status >= 500) {
    return new AiError(
      AiErrorCode.NetworkError,
      localize('ai.error.ollama.serverError', 'Ollama server error ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  return new AiError(
    AiErrorCode.Unknown,
    localize('ai.error.ollama.requestFailed', 'Ollama request failed ({status}): {detail}', {
      status: String(status),
      detail,
    }),
  )
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
