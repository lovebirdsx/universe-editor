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
  bareModelName,
  buildModelConfigSchema,
  CancellationError,
  composeModelId,
  DeferredPromise,
  DisposableStore,
  type AiCustomModelConfig,
  type AiMessage,
  type AiModelConfigSchema,
  type AiRequestOptions,
  type AiResolvedGroup,
  type AiResponse,
  type AiRequestResult,
  type AiModelMetadata,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
} from '@universe-editor/platform'
import { retryWithBackoff } from './retry.js'

const VENDOR = 'openai'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
// OpenAI exposes per-model context windows only out-of-band; use a safe default.
const DEFAULT_MAX_TOKENS = 8192

/** Tunable request parameters shared by every OpenAI-compatible model. */
const BASE_SCHEMA: AiModelConfigSchema = {
  temperature: { type: 'number', description: 'Sampling temperature (0–2).', group: 'navigation' },
  maxTokens: { type: 'number', description: 'Maximum tokens to generate.' },
  topP: { type: 'number', description: 'Nucleus sampling probability (0–1).' },
  frequencyPenalty: {
    type: 'number',
    description: 'Penalize tokens by their existing frequency (−2 to 2).',
  },
  presencePenalty: {
    type: 'number',
    description: 'Penalize tokens that have already appeared (−2 to 2).',
  },
  seed: { type: 'number', description: 'Seed for (best-effort) deterministic sampling.' },
}

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

export class OpenAiProvider implements IAiModelProvider {
  async provideModels(
    group: AiResolvedGroup,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    const apiKey = await group.getApiKey()
    const signals = new DisposableStore()
    let res: Response | undefined
    try {
      res = await fetch(`${baseUrl(group)}/models`, {
        headers: authHeaders(apiKey),
        signal: toAbortSignal(token, signals),
      })
    } catch {
      // Endpoint unreachable — fall back to declared models only.
      res = undefined
    } finally {
      signals.dispose()
    }
    const enumerated =
      res && res.ok ? (((await res.json()) as { data?: OpenAiModelEntry[] }).data ?? []) : []
    return mergeModels(
      group,
      enumerated.map((entry) => entry.id),
    )
  }

  sendRequest(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    group: AiResolvedGroup,
    token: CancellationToken,
  ): AiResponse {
    const source = new AsyncIterableSource<AiResponseChunk>()
    const result = new DeferredPromise<AiRequestResult>()
    // A consumer may read only `stream`; keep result from surfacing unhandled.
    result.p.catch(() => undefined)

    void this._run(messages, options, group, token, source, result)
    return { stream: source.asyncIterable, result: result.p }
  }

  private async _run(
    messages: readonly AiMessage[],
    options: AiRequestOptions,
    group: AiResolvedGroup,
    token: CancellationToken,
    source: AsyncIterableSource<AiResponseChunk>,
    result: DeferredPromise<AiRequestResult>,
  ): Promise<void> {
    let usage: { inputTokens: number; outputTokens: number } | undefined
    const signals = new DisposableStore()
    try {
      const apiKey = await group.getApiKey()

      const res = await retryWithBackoff(
        () =>
          fetch(`${baseUrl(group)}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
            body: JSON.stringify(
              buildChatBody(bareModelName(options.modelId, VENDOR, group.name), messages, options),
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

function baseUrl(group: AiResolvedGroup): string {
  return (group.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** Endpoint-enumerated ids + hand-declared models (declared wins on id clash). */
function mergeModels(group: AiResolvedGroup, ids: readonly string[]): AiModelMetadata[] {
  const declared = new Map((group.declaredModels ?? []).map((m) => [m.id, m]))
  const out: AiModelMetadata[] = []
  for (const id of ids) {
    if (declared.has(id)) continue
    out.push(toMetadata(group, id))
  }
  for (const config of group.declaredModels ?? []) {
    out.push(declaredMetadata(group, config))
  }
  return out
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
  // keys map to their snake_case body field; any other key (a hand-declared
  // model's custom parameter) is passed through under its own name.
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

function toMetadata(group: AiResolvedGroup, id: string): AiModelMetadata {
  return {
    id: composeModelId(VENDOR, group.name, id),
    vendor: VENDOR,
    groupName: group.name,
    name: id,
    family: id,
    maxInputTokens: DEFAULT_MAX_TOKENS,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    capabilities: { streaming: true },
    configurationSchema: BASE_SCHEMA,
  }
}

function declaredMetadata(group: AiResolvedGroup, config: AiCustomModelConfig): AiModelMetadata {
  const schema = buildModelConfigSchema(config, BASE_SCHEMA)
  return {
    id: composeModelId(VENDOR, group.name, config.id),
    vendor: VENDOR,
    groupName: group.name,
    name: config.name ?? config.id,
    family: config.family ?? config.id,
    maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_TOKENS,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    capabilities: config.capabilities ?? { streaming: true },
    ...(schema ? { configurationSchema: schema } : {}),
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
