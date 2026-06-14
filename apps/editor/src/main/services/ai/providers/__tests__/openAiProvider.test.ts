/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiProvider — SSE parsing into text/usage chunks, the no-key path
 *  (empty model list / unauthorized request), HTTP error mapping, and cancellation.
 *  `fetch` is stubbed; no real network is touched.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiError,
  AiErrorCode,
  AiMessageRole,
  CancellationError,
  CancellationTokenSource,
  getTextResponse,
  type AiMessage,
  type ISecretStorageService,
} from '@universe-editor/platform'
import { OpenAiProvider } from '../openAiProvider.js'
import type { AiProviderContext } from '../../aiModelMainService.js'

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

function makeSecrets(apiKey: string | undefined): ISecretStorageService {
  return {
    _serviceBrand: undefined,
    get: () => Promise.resolve(apiKey),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  }
}

function makeContext(opts: { apiKey?: string; baseUrl?: string }): AiProviderContext {
  return {
    secrets: makeSecrets(opts.apiKey),
    getVendorConfig: (vendor) =>
      vendor === 'openai' && opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : undefined,
    getRequestDefaults: () => ({}),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAiProvider', () => {
  it('returns no models when no API key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const provider = new OpenAiProvider(makeContext({}))
    const cts = new CancellationTokenSource()

    const models = await provider.provideModels(cts.token)

    expect(models).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lists models prefixed with the vendor id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }), {
        status: 200,
      }),
    )
    const provider = new OpenAiProvider(makeContext({ apiKey: 'sk-test' }))
    const cts = new CancellationTokenSource()

    const models = await provider.provideModels(cts.token)

    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o-mini', 'openai/gpt-4o'])
    expect(models[0]!.vendor).toBe('openai')
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
    const provider = new OpenAiProvider(makeContext({ apiKey: 'sk-test' }))
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(userMessages, { modelId: 'openai/gpt-4o' }, cts.token)
    const text = await getTextResponse(response)
    const result = await response.result

    expect(text).toBe('Hello')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
  })

  it('sends the bare model name and a Bearer auth header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 }))
    const provider = new OpenAiProvider(makeContext({ apiKey: 'sk-test' }))
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(userMessages, { modelId: 'openai/gpt-4o' }, cts.token)
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
    const provider = new OpenAiProvider(makeContext({ apiKey: 'sk-bad' }))
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(userMessages, { modelId: 'openai/gpt-4o' }, cts.token)

    await expect(response.result).rejects.toMatchObject({
      code: AiErrorCode.Unauthorized,
    })
  })

  it('rejects with Unauthorized when sending without an API key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const provider = new OpenAiProvider(makeContext({}))
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(userMessages, { modelId: 'openai/gpt-4o' }, cts.token)

    await expect(response.result).rejects.toBeInstanceOf(AiError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honors a custom OpenAI-compatible baseUrl', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const provider = new OpenAiProvider(
      makeContext({ apiKey: 'sk-test', baseUrl: 'http://localhost:1234/v1/' }),
    )
    const cts = new CancellationTokenSource()

    await provider.provideModels(cts.token)

    expect(fetchSpy.mock.calls[0]![0]).toBe('http://localhost:1234/v1/models')
  })

  it('surfaces cancellation as a CancellationError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const provider = new OpenAiProvider(makeContext({ apiKey: 'sk-test' }))
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(userMessages, { modelId: 'openai/gpt-4o' }, cts.token)
    cts.cancel()

    await expect(response.result).rejects.toBeInstanceOf(CancellationError)
  })
})
