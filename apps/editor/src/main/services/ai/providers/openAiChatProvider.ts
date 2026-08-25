/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OpenAI Chat Completions provider — speaks the `openai-chat` wire protocol, against
 *  api.openai.com or any OpenAI-compatible endpoint (LM Studio, vLLM, DeepSeek, …) via a
 *  configurable baseUrl. The provider id segment of model ids comes from the runtime,
 *  never a constant. Models come from GET /models; chat streams Server-Sent Events from
 *  POST /chat/completions.
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Maps camelCase config keys to the snake_case fields the OpenAI API expects. */
const PARAM_TO_BODY: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  maxTokens: 'max_tokens',
  topP: 'top_p',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  seed: 'seed',
  reasoningEffort: 'reasoning_effort',
}

interface OpenAiModelEntry {
  readonly id: string
}

interface OpenAiChatStreamChunk {
  readonly choices?: ReadonlyArray<{ readonly delta?: { readonly content?: string } }>
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

export class OpenAiChatProvider implements IAiModelProvider {
  async listModels(
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const apiKey = provider.apiKey
    const signals = new DisposableStore()
    let res: Response
    try {
      res = await fetch(`${baseUrl(provider)}/models`, {
        headers: authHeaders(apiKey),
        signal: toAbortSignal(token, signals),
      })
    } catch (err) {
      throw modelsNetworkError(err, token)
    } finally {
      signals.dispose()
    }
    if (!res.ok) throw modelsEndpointError(res.status)
    return (((await res.json()) as { data?: OpenAiModelEntry[] }).data ?? []).map(
      (entry) => entry.id,
    )
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
      const apiKey = provider.apiKey

      const res = await retryWithBackoff(
        () =>
          fetch(`${baseUrl(provider)}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
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

function baseUrl(provider: AiProviderRuntime): string {
  return (provider.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
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
  // Per-model configuration first, then per-request options override it. Known
  // keys map to their snake_case body field; any other key is passed through
  // under its own name.
  const cfg = options.modelConfiguration ?? {}
  for (const [key, value] of Object.entries(cfg)) {
    body[PARAM_TO_BODY[key] ?? key] = value
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
      localize('ai.error.unauthorized', 'OpenAI unauthorized ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status === 429) {
    return new AiError(
      AiErrorCode.RateLimited,
      localize('ai.error.rateLimited', 'OpenAI rate limited ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status >= 500) {
    return new AiError(
      AiErrorCode.NetworkError,
      localize('ai.error.serverError', 'OpenAI server error ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  return new AiError(
    AiErrorCode.Unknown,
    localize('ai.error.requestFailed', 'OpenAI request failed ({status}): {detail}', {
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
