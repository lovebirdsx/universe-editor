/*---------------------------------------------------------------------------------------------
 *  Tests for AnthropicMessagesProvider — SSE text/usage reassembly, system-prompt hoisting,
 *  same-role merging, usage-bucket summation, HTTP error mapping, cancellation, model
 *  enumeration (listModels), and the required `max_tokens` fallback. `fetch` is stubbed;
 *  no real network is touched.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AiMessageRole,
  CancellationError,
  CancellationTokenSource,
  getTextResponse,
  type AiMessage,
  type AiProviderRuntime,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { AnthropicMessagesProvider } from '../anthropicMessagesProvider.js'

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

/** One Anthropic SSE event: an `event:` line (ignored by the reader) plus a `data:` line. */
function sse(obj: Record<string, unknown>): string {
  return `event: ${String(obj.type ?? 'message_start')}\ndata: ${JSON.stringify(obj)}\n`
}

function makeProvider(opts: { apiKey?: string; baseUrl?: string; id?: string }): AiProviderRuntime {
  return {
    id: opts.id ?? 'anthropic',
    protocol: 'anthropic-messages' as AiWireProtocol,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

const MODEL_ID = 'anthropic/anthropic-messages/claude-sonnet-5'

afterEach(() => {
  vi.unstubAllGlobals()
})

function bodyOf(mock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse((mock.mock.calls[call]![1] as RequestInit).body as string)
}

describe('AnthropicMessagesProvider', () => {
  it('concatenates text deltas into text chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            streamFromChunks([
              sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
              sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }),
              sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }),
              sse({ type: 'message_delta', usage: { output_tokens: 2 } }),
            ]),
            { status: 200 },
          ),
        ),
    )
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    const text = await getTextResponse(response)

    expect(text).toBe('Hello')
  })

  it('hoists system messages into a top-level system string, not into messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(streamFromChunks([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const messages: readonly AiMessage[] = [
      { role: AiMessageRole.System, content: [{ type: 'text', value: 'you are helpful' }] },
      { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
    ]
    const response = provider.sendRequest(
      messages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    await getTextResponse(response)

    const body = bodyOf(fetchMock, 0)
    expect(body.system).toBe('you are helpful')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('merges consecutive same-role messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(streamFromChunks([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const messages: readonly AiMessage[] = [
      { role: AiMessageRole.User, content: [{ type: 'text', value: 'a' }] },
      { role: AiMessageRole.User, content: [{ type: 'text', value: 'b' }] },
      { role: AiMessageRole.Assistant, content: [{ type: 'text', value: 'c' }] },
      { role: AiMessageRole.Assistant, content: [{ type: 'text', value: 'd' }] },
      { role: AiMessageRole.User, content: [{ type: 'text', value: 'e' }] },
    ]
    const response = provider.sendRequest(
      messages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    await getTextResponse(response)

    const body = bodyOf(fetchMock, 0)
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'ab' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'cd' }] },
      { role: 'user', content: [{ type: 'text', text: 'e' }] },
    ])
  })

  it('sums the four usage buckets into a single inputTokens total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          streamFromChunks([
            sse({
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 2,
                  cache_read_input_tokens: 3,
                },
              },
            }),
            sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
            sse({ type: 'message_delta', usage: { output_tokens: 5 } }),
          ]),
          { status: 200 },
        ),
      ),
    )
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )
    const result = await response.result

    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 5 })
  })

  it('maps a 401 response to an Unauthorized AiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: MODEL_ID },
      makeProvider({ apiKey: 'sk-bad' }),
      cts.token,
    )

    await expect(response.result).rejects.toMatchObject({ code: AiErrorCode.Unauthorized })
  })

  it('surfaces cancellation as a CancellationError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const provider = new AnthropicMessagesProvider()
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

  it('listModels returns the endpoint-enumerated ids as a string array', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-4-8' }] }),
            { status: 200 },
          ),
        ),
    )
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token)

    expect(models).toEqual(['claude-sonnet-5', 'claude-opus-4-8'])
  })

  // Swallowing this into [] made a dead endpoint indistinguishable from one
  // serving no models, which is what the settings probe has to tell apart.
  it('listModels throws a network error when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    await expect(
      provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token),
    ).rejects.toMatchObject({ code: AiErrorCode.NetworkError })
  })

  it('always sends max_tokens with options > modelConfiguration > 4096 precedence', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) => resolve(new Response(streamFromChunks([]), { status: 200 }))),
      )
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicMessagesProvider()
    const cts = new CancellationTokenSource()

    await getTextResponse(
      provider.sendRequest(
        userMessages,
        { modelId: MODEL_ID, maxTokens: 100, modelConfiguration: { maxTokens: 200 } },
        makeProvider({ apiKey: 'sk-test' }),
        cts.token,
      ),
    )
    expect(bodyOf(fetchMock, 0).max_tokens).toBe(100)

    await getTextResponse(
      provider.sendRequest(
        userMessages,
        { modelId: MODEL_ID, modelConfiguration: { maxTokens: 200 } },
        makeProvider({ apiKey: 'sk-test' }),
        cts.token,
      ),
    )
    expect(bodyOf(fetchMock, 1).max_tokens).toBe(200)

    await getTextResponse(
      provider.sendRequest(
        userMessages,
        { modelId: MODEL_ID },
        makeProvider({ apiKey: 'sk-test' }),
        cts.token,
      ),
    )
    expect(bodyOf(fetchMock, 2).max_tokens).toBe(4096)
  })
})
