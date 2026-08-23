/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Anthropic Messages provider — speaks the `anthropic-messages` wire protocol against
 *  api.anthropic.com. Models come from GET /v1/models; chat streams Server-Sent Events
 *  from POST /v1/messages. The system prompt is a top-level field (not a message), and
 *  messages must alternate user/assistant.
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
import { retryWithBackoff, toAbortSignal } from './retry.js'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

/** Maps camelCase config keys to the snake_case fields the Anthropic API expects. */
const PARAM_TO_BODY: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  maxTokens: 'max_tokens',
  topP: 'top_p',
  topK: 'top_k',
}

interface AnthropicModelEntry {
  readonly id: string
  readonly display_name?: string
  readonly created_at?: string
}

interface AnthropicUsage {
  readonly input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly output_tokens?: number
}

interface AnthropicStreamEvent {
  readonly type?: string
  readonly delta?: { readonly type?: string; readonly text?: string }
  readonly message?: { readonly usage?: AnthropicUsage }
  readonly usage?: AnthropicUsage
  readonly error?: { readonly type?: string; readonly message?: string }
}

interface AnthropicStreamMessage {
  role: 'user' | 'assistant'
  content: { type: 'text'; text: string }[]
}

export class AnthropicMessagesProvider implements IAiModelProvider {
  async listModels(
    provider: AiProviderRuntime,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const signals = new DisposableStore()
    let res: Response | undefined
    try {
      res = await fetch(`${baseUrl(provider)}/v1/models`, {
        headers: anthropicHeaders(provider.apiKey),
        signal: toAbortSignal(token, signals),
      })
    } catch {
      // Endpoint unreachable — nothing to enumerate.
      res = undefined
    } finally {
      signals.dispose()
    }
    if (!res || !res.ok) return []
    return (((await res.json()) as { data?: AnthropicModelEntry[] }).data ?? []).map(
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
    const signals = new DisposableStore()
    // The four usage buckets are tracked separately for future extension, but the
    // platform's AiRequestResult/AiResponseChunk only carry inputTokens/outputTokens
    // today. inputTokens is reported as input + cache-creation + cache-read because
    // consumers use it for context occupancy, which must count cached tokens too.
    let inputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let outputTokens = 0
    try {
      const res = await retryWithBackoff(
        () =>
          fetch(`${baseUrl(provider)}/v1/messages`, {
            method: 'POST',
            headers: anthropicHeaders(provider.apiKey),
            body: JSON.stringify(
              buildMessagesBody(
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

      for await (const evt of readSse(res.body, token)) {
        switch (evt.type) {
          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              source.emitOne({ type: 'text', value: evt.delta.text })
            }
            break
          case 'message_start':
            inputTokens = evt.message?.usage?.input_tokens ?? 0
            cacheCreationTokens = evt.message?.usage?.cache_creation_input_tokens ?? 0
            cacheReadTokens = evt.message?.usage?.cache_read_input_tokens ?? 0
            break
          case 'message_delta':
            outputTokens = evt.usage?.output_tokens ?? outputTokens
            break
          case 'error':
            throw new AiError(AiErrorCode.Unknown, evt.error?.message ?? 'Anthropic stream error')
        }
      }

      const usage = {
        inputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
        outputTokens,
      }
      source.emitOne({ type: 'usage', ...usage })
      source.resolve()
      result.complete({ usage })
    } catch (err) {
      const error = normalizeError(err, token)
      source.reject(error)
      result.error(error)
    } finally {
      signals.dispose()
    }
  }

  async provideTokenCount(_modelId: string, text: string): Promise<number> {
    // No token-count endpoint; approximate ~4 chars/token like the OpenAI provider.
    return Math.ceil(text.length / 4)
  }
}

function baseUrl(provider: AiProviderRuntime): string {
  return (provider.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  }
}

function buildMessagesBody(
  model: string,
  messages: readonly AiMessage[],
  options: AiRequestOptions,
): Record<string, unknown> {
  const cfg = options.modelConfiguration ?? {}
  const body: Record<string, unknown> = {
    model,
    stream: true,
    ...splitSystemAndMessages(messages),
  }
  // Per-model configuration first, then per-request options override it. Known
  // keys map to their snake_case body field; any other key is passed through
  // under its own name.
  for (const [key, value] of Object.entries(cfg)) {
    body[PARAM_TO_BODY[key] ?? key] = value
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop_sequences = [...options.stop]
  // max_tokens is required by the Messages API; the config loop may not have set it.
  if (body.max_tokens === undefined) body.max_tokens = 4096
  return { ...body, ...(options.extra ?? {}) }
}

/** Hoist system messages into a top-level `system` string and merge consecutive same-role messages. */
function splitSystemAndMessages(messages: readonly AiMessage[]): {
  system?: string
  messages: AnthropicStreamMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicStreamMessage[] = []
  for (const m of messages) {
    const text = m.content
      .filter((p): p is { type: 'text'; value: string } => p.type === 'text')
      .map((p) => p.value)
      .join('')
    if (m.role === AiMessageRole.System) {
      if (text) systemParts.push(text)
      continue
    }
    const role: 'user' | 'assistant' = m.role === AiMessageRole.Assistant ? 'assistant' : 'user'
    const last = out[out.length - 1]
    if (last?.role === role) {
      last.content[0] = { type: 'text', text: (last.content[0]?.text ?? '') + text }
    } else {
      out.push({ role, content: [{ type: 'text', text }] })
    }
  }
  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n') } : {}),
    messages: out,
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  token: CancellationToken,
): AsyncGenerator<AnthropicStreamEvent> {
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
        if (!rawLine.startsWith('data:')) continue
        const payload = rawLine.slice('data:'.length).trim()
        if (!payload) continue
        yield JSON.parse(payload) as AnthropicStreamEvent
      }
    }
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
      localize('ai.error.anthropic.unauthorized', 'Anthropic unauthorized ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status === 429) {
    return new AiError(
      AiErrorCode.RateLimited,
      localize('ai.error.anthropic.rateLimited', 'Anthropic rate limited ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  if (status >= 500) {
    return new AiError(
      AiErrorCode.NetworkError,
      localize('ai.error.anthropic.serverError', 'Anthropic server error ({status}): {detail}', {
        status: String(status),
        detail,
      }),
    )
  }
  return new AiError(
    AiErrorCode.Unknown,
    localize('ai.error.anthropic.requestFailed', 'Anthropic request failed ({status}): {detail}', {
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
