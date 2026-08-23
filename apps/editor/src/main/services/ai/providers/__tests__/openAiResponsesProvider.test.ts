/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiResponsesProvider — the stub enumerates no models (never touching the
 *  network) and rejects every request with ConfigurationRequired on both stream and result.
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
  it('listModels returns an empty list without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.listModels(makeProvider({ apiKey: 'sk-test' }), cts.token)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(models).toEqual([])
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
