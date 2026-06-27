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
  bareModelName,
  CancellationError,
  composeModelId,
  DeferredPromise,
  DisposableStore,
  type AiCustomModelConfig,
  type AiMessage,
  type AiRequestOptions,
  type AiResolvedGroup,
  type AiResponse,
  type AiRequestResult,
  type AiModelMetadata,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
} from '@universe-editor/platform'
import { retryWithBackoff, toAbortSignal } from './retry.js'

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
  async provideModels(
    group: AiResolvedGroup,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    const signals = new DisposableStore()
    let res: Response | undefined
    try {
      res = await fetch(`${baseUrl(group)}/api/tags`, { signal: toAbortSignal(token, signals) })
    } catch {
      // Server not running / unreachable — fall back to declared models only.
      res = undefined
    } finally {
      signals.dispose()
    }
    const enumerated =
      res && res.ok ? (((await res.json()) as { models?: OllamaTag[] }).models ?? []) : []
    return mergeModels(
      group,
      enumerated.map((tag) => tag.name),
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
      const res = await retryWithBackoff(
        () =>
          fetch(`${baseUrl(group)}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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

function baseUrl(group: AiResolvedGroup): string {
  return (group.baseUrl?.replace(/\/+$/, '') || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** Endpoint-enumerated names + hand-declared models (declared wins on id clash). */
function mergeModels(group: AiResolvedGroup, names: readonly string[]): AiModelMetadata[] {
  const declared = new Map((group.declaredModels ?? []).map((m) => [m.id, m]))
  const seen = new Set<string>()
  const out: AiModelMetadata[] = []
  for (const name of names) {
    if (declared.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(toMetadata(group, name))
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

function toMetadata(group: AiResolvedGroup, name: string): AiModelMetadata {
  return {
    id: composeModelId(VENDOR, group.name, name),
    vendor: VENDOR,
    groupName: group.name,
    name,
    family: name.split(':')[0] ?? name,
    maxInputTokens: DEFAULT_MAX_TOKENS,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    capabilities: { streaming: true },
  }
}

function declaredMetadata(group: AiResolvedGroup, config: AiCustomModelConfig): AiModelMetadata {
  return {
    id: composeModelId(VENDOR, group.name, config.id),
    vendor: VENDOR,
    groupName: group.name,
    name: config.name ?? config.id,
    family: config.family ?? config.id.split(':')[0] ?? config.id,
    maxInputTokens: config.maxInputTokens ?? DEFAULT_MAX_TOKENS,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    capabilities: config.capabilities ?? { streaming: true },
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
