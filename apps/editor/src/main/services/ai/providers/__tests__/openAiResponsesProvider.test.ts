/*---------------------------------------------------------------------------------------------
 *  Tests for OpenAiResponsesProvider — the stub lists only declared models (never touching
 *  the network) and rejects every request with ConfigurationRequired on both stream and result.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AiMessageRole,
  CancellationTokenSource,
  getTextResponse,
  type AiMessage,
  type AiCustomModelConfig,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import { OpenAiResponsesProvider } from '../openAiResponsesProvider.js'

function makeProvider(opts: {
  apiKey?: string
  name?: string
  type?: string
  models?: readonly AiCustomModelConfig[]
}): AiResolvedProvider {
  return {
    type: opts.type ?? 'openai',
    name: opts.name ?? 'default',
    protocol: 'openai-responses',
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.models !== undefined ? { declaredModels: opts.models } : {}),
  }
}

const userMessages: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAiResponsesProvider', () => {
  it('lists only declared models without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    const models = await provider.provideModels(
      makeProvider({ models: [{ id: 'gpt-5.4', pricing: { input: 2.5, output: 15 } }] }),
      cts.token,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(models.map((m) => m.id)).toEqual(['openai/default/gpt-5.4'])
    expect(models[0]!.pricingOrigin).toBe('model')
  })

  it('rejects both stream and result with ConfigurationRequired', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new OpenAiResponsesProvider()
    const cts = new CancellationTokenSource()

    const response = provider.sendRequest(
      userMessages,
      { modelId: 'openai/default/gpt-5.4' },
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
