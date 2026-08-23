/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiChatProvider — SSE parsing into text/usage chunks, model enumeration
 *  (listModels), HTTP error mapping, baseUrl override, cancellation, and per-model config
 *  mapping. `fetch` is stubbed; no real network is touched. Each call receives an
 *  AiProviderRuntime (provider id + protocol + inline apiKey/baseUrl).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AiMessageRole,
  CancellationError,
  CancellationTokenSource,
  DisposableTracker,
  getTextResponse,
  setDisposableTracker,
  type AiMessage,
  type AiProviderRuntime,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { OpenAiChatProvider } from '../openAiChatProvider.js'

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!))
        i++
      } else {
        controller.close()
      }
    },
  })
}

function sseLine(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`
}

function makeProvider(opts: { apiKey?: string; baseUrl?: string; id?: string }): AiProviderRuntime {
  return {
    id: opts.id ?? 'openai',
    protocol: 'openai-chat' as AiWireProtocol,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

const MODEL_ID = 'openai/openai-chat/gpt-4o'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAiChatProvider', () => {
  it('listModels returns the endpoint-enumerated ids as a string array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }), {
        status: 200,
      }),
    )
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token)

    expect(models).toEqual(['gpt-4o-mini', 'gpt-4o'])
  })

  it('listModels returns an empty list when the endpoint is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token)

    expect(models).toEqual([])
  })

  it('listModels returns an empty list on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-bad' }), cts.token)

    expect(models).toEqual([])
  })

  it('parses SSE deltas into text chunks and stops at [DONE]', async () => {
    const body = streamFromChunks([
      sseLine('Hel'),
      sseLine('lo'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n`,
      'data: [DONE]\n',
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    const text = await getTextResponse(response)
    const result = await response.result

    expect(text).toBe('Hello')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
  })

  it('sends the bare model name and a Bearer auth header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    await getTextResponse(response)

    const [, init] = fetchSpy.mock.calls[0]!
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody.model).toBe('gpt-4o')
    expect(sentBody.stream).toBe(true)
  })

  it('maps a 401 response to an Unauthorized AiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-bad' }),
      cts.token,
    )

    await expect(response.result).rejects.toMatchObject({
      code: AiErrorCode.Unauthorized,
    })
  })

  it('honors a custom OpenAI-compatible baseUrl', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    await provider.listModels(
      makeProvider({ apiKey: 'sk-test', baseUrl: 'http://localhost:1234/v1/' }),
      cts.token,
    )

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/models')
  })

  it('applies per-model configuration (reasoningEffort) to the request body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      {
        modelId: MODEL_ID,
        modelConfiguration: { temperature: 0.2, reasoningEffort: 'high' },
      },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    await getTextResponse(response)

    const [, init] = fetchSpy.mock.calls[0]!
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody.temperature).toBe(0.2)
    expect(sentBody.reasoning_effort).toBe('high')
  })

  it('maps known params to snake_case and passes custom params through verbatim', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 }))
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      {
        modelId: MODEL_ID,
        modelConfiguration: {
          topP: 0.9,
          frequencyPenalty: 0.5,
          presencePenalty: 0.1,
          seed: 42,
          // A hand-declared model's custom parameter, sent under its own name.
          top_k: 20,
        },
      },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    await getTextResponse(response)

    const [, init] = fetchSpy.mock.calls[0]!
    const sentBody = JSON.parse((init as RequestInit).body as string)
    expect(sentBody.top_p).toBe(0.9)
    expect(sentBody.frequency_penalty).toBe(0.5)
    expect(sentBody.presence_penalty).toBe(0.1)
    expect(sentBody.seed).toBe(42)
    expect(sentBody.top_k).toBe(20)
  })

  it('surfaces cancellation as a CancellationError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const provider = new OpenAiChatProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    cts.cancel()

    await expect(response.result).rejects.toBeInstanceOf(CancellationError)
  })

  it('releases the abort pipeline synchronously on cancel, before _run settles', async () => {
    // fetch hangs forever and ignores the abort: _run stays parked in its await,
    // so its finally never runs. The abort store and its cancellation listener
    // must still be torn down by cancel() itself — mirroring shutdown, where the
    // process-exit leak check is synchronous and beats _run's microtask finally.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      const provider = new OpenAiChatProvider()
      const cts = new CancellationTokenSource()

      provider.sendRequest(
        userMessages,
        { modelId: MODEL_ID },
        makeProvider({ apiKey: 'sk-test' }),
        cts.token,
      )
      // Let _run reach `await fetch(...)` so the abort store + listener exist.
      await Promise.resolve()
      cts.cancel()
      cts.dispose()

      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
    }
  })
})
