/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiResponsesProvider — listModels really probes `GET /models` (the
 *  agent settings panel's Test button proves reachability through it), while
 *  sendRequest stays a stub that rejects with ConfigurationRequired on both
 *  stream and result.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AiMessageRole,
  CancellationTokenSource,
  getTextResponse,
  type AiMessage,
  type AiProviderRuntime,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { OpenAiResponsesProvider } from '../openAiResponsesProvider.js'

function makeProvider(opts: { apiKey?: string; id?: string }): AiProviderRuntime {
  return {
    id: opts.id ?? 'openai',
    protocol: 'openai-responses' as AiWireProtocol,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAiResponsesProvider', () => {
  it('listModels probes the endpoint and returns the ids it serves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/models')
    expect(models).toEqual(['gpt-5.5', 'gpt-5.5-mini'])
  })

  it('listModels throws with the HTTP status so a bad key is distinguishable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    await expect(
      provider.listModels(makeProvider({ apiKey: 'sk-bad' }), cts.token),
    ).rejects.toMatchObject({ code: AiErrorCode.Unauthorized, status: 401 })
  })

  it('rejects both stream and result with ConfigurationRequired', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/openai-responses/gpt-5.4' },
      makeProvider({ apiKey: 'sk-test' }),
      cts.token,
    )

    await expect(getTextResponse(response)).rejects.toMatchObject({
      code: AiErrorCode.ConfigurationRequired,
    })
    await expect(response.result).rejects.toMatchObject({
      code: AiErrorCode.ConfigurationRequired,
    })
  })
})
