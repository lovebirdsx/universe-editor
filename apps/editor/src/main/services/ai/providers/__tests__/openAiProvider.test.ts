/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiProvider — SSE parsing into text/usage chunks, model enumeration
 *  merged with hand-declared models, HTTP error mapping, baseUrl override, and
 *  cancellation. `fetch` is stubbed; no real network is touched. The provider is
 *  now group-based: each call receives an AiResolvedGroup (baseUrl + lazy key).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AiMessageRole,
  CancellationError,
  CancellationTokenSource,
  getTextResponse,
  type AiMessage,
  type AiCustomModelConfig,
  type AiResolvedGroup,
} from '@universe-editor/platform'
import { OpenAiProvider } from '../openAiProvider.js'

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

function makeGroup(opts: {
  apiKey?: string
  baseUrl?: string
  name?: string
  models?: readonly AiCustomModelConfig[]
}): AiResolvedGroup {
  return {
    vendor: 'openai',
    name: opts.name ?? 'default',
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.models !== undefined ? { declaredModels: opts.models } : {}),
    getApiKey: () => Promise.resolve(opts.apiKey),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAiProvider', () => {
  it('falls back to declared models when the endpoint is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const group = makeGroup({ models: [{ id: 'qwen3-coder' }] })
    const models = await provider.provideModels(group, cts.token)

    expect(models.map((m) => m.id)).toEqual(['openai/default/qwen3-coder'])
  })

  it('lists models with three-segment ids and merges declared models', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }), {
        status: 200,
      }),
    )
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const group = makeGroup({ apiKey: 'sk-test', models: [{ id: 'custom-model' }] })
    const models = await provider.provideModels(group, cts.token)

    expect(models.map((m) => m.id)).toEqual([
      'openai/default/gpt-4o-mini',
      'openai/default/gpt-4o',
      'openai/default/custom-model',
    ])
    expect(models[0]!.vendor).toBe('openai')
    expect(models[0]!.groupName).toBe('default')
    expect(models[0]!.name).toBe('gpt-4o-mini')
  })

  it('parses SSE deltas into text chunks and stops at [DONE]', async () => {
    const body = streamFromChunks([
      sseLine('Hel'),
      sseLine('lo'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n`,
      'data: [DONE]\n',
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/default/gpt-4o' },
      makeGroup({ apiKey: 'sk-test' }),
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
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/default/gpt-4o' },
      makeGroup({ apiKey: 'sk-test' }),
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
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/default/gpt-4o' },
      makeGroup({ apiKey: 'sk-bad' }),
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
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    await provider.provideModels(
      makeGroup({ apiKey: 'sk-test', baseUrl: 'http://localhost:1234/v1/' }),
      cts.token,
    )

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/models')
  })

  it('applies per-model configuration (reasoningEffort) to the request body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 }))
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      {
        modelId: 'openai/default/gpt-4o',
        modelConfiguration: { temperature: 0.2, reasoningEffort: 'high' },
      },
      makeGroup({ apiKey: 'sk-test' }),
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
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      {
        modelId: 'openai/default/gpt-4o',
        modelConfiguration: {
          topP: 0.9,
          frequencyPenalty: 0.5,
          presencePenalty: 0.1,
          seed: 42,
          // A hand-declared model's custom parameter, sent under its own name.
          top_k: 20,
        },
      },
      makeGroup({ apiKey: 'sk-test' }),
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
    const provider = new OpenAiProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/default/gpt-4o' },
      makeGroup({ apiKey: 'sk-test' }),
      cts.token,
    )
    cts.cancel()

    await expect(response.result).rejects.toBeInstanceOf(CancellationError)
  })
})
