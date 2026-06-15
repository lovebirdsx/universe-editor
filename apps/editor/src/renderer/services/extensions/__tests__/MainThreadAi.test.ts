import { describe, expect, it } from 'vitest'
import {
  AiMessageRole,
  Event,
  type AiMessage,
  type AiModelSelector,
  type AiRequestOptions,
  type AiResponse,
  type CancellationToken,
  type IAiModelService,
} from '@universe-editor/platform'
import { MainThreadAi } from '../MainThreadAi.js'

const fakeAi: IAiModelService = {
  _serviceBrand: undefined,
  onDidChangeModels: Event.None,
  getModels: () => Promise.resolve([]),
  selectModels: (_selector: AiModelSelector) => Promise.resolve([]),
  computeTokenLength: (_modelId: string, _text: string, _token: CancellationToken) =>
    Promise.resolve(0),
  sendRequest: (
    _messages: readonly AiMessage[],
    _options: AiRequestOptions,
    _token: CancellationToken,
  ): AiResponse => {
    throw new Error('sync main fail')
  },
  setApiKey: (_vendor: string, _key: string) => Promise.resolve(),
  deleteApiKey: (_vendor: string) => Promise.resolve(),
  hasApiKey: (_vendor: string) => Promise.resolve(false),
}

describe('MainThreadAi', () => {
  it('reports synchronous sendRequest failures through the end event', async () => {
    const bridge = new MainThreadAi(fakeAi)
    const ended = new Promise<{ error?: { message: string } }>((resolve) => {
      bridge.onDidEndRequest((e) => resolve(e))
    })

    await expect(
      bridge.startRequest(
        'r1',
        [{ role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] }],
        { modelId: 'm' },
      ),
    ).resolves.toBeUndefined()

    await expect(ended).resolves.toMatchObject({
      error: { message: 'sync main fail' },
    })
    bridge.dispose()
  })
})
