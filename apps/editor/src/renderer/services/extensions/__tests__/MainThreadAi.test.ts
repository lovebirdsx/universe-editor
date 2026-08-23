import { describe, expect, it } from 'vitest'
import {
  AiMessageRole,
  Event,
  type AiAccountUsage,
  type AiMessage,
  type AiModelConfiguration,
  type AiModelKnowledge,
  type AiModelSelector,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiProviderVerifyInput,
  type AiRateTableSnapshot,
  type AiRequestOptions,
  type AiResponse,
  type CancellationToken,
  type IAiModelService,
} from '@universe-editor/platform'
import { MainThreadAi } from '../MainThreadAi.js'

const fakeAi: IAiModelService = {
  _serviceBrand: undefined,
  onDidChangeModels: Event.None,
  onDidChangeActiveModel: Event.None,
  onDidChangeInlineCompletionModel: Event.None,
  onDidChangeCommitModel: Event.None,
  onDidChangeSessionTitleModel: Event.None,
  onDidChangeRemote: Event.None,
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
  getActiveModelId: () => Promise.resolve(undefined),
  setActiveModelId: (_modelId: string | undefined) => Promise.resolve(),
  getInlineCompletionModelId: () => Promise.resolve(undefined),
  setInlineCompletionModelId: (_modelId: string | undefined) => Promise.resolve(),
  getCommitModelId: () => Promise.resolve(undefined),
  setCommitModelId: (_modelId: string | undefined) => Promise.resolve(),
  getSessionTitleModelId: () => Promise.resolve(undefined),
  setSessionTitleModelId: (_modelId: string | undefined) => Promise.resolve(),
  getModelConfiguration: (_modelId: string) => Promise.resolve({}),
  setModelConfiguration: (_modelId: string, _config: AiModelConfiguration) => Promise.resolve(),
  getProviders: () => Promise.resolve([]),
  updateProviders: (_providers: readonly AiProviderEntry[]) => Promise.resolve(),
  getModelKnowledge: () => Promise.resolve({} as Readonly<Record<string, AiModelKnowledge>>),
  getProviderIssues: () => Promise.resolve([] as readonly AiProviderIssue[]),
  isLegacySettingsFormat: () => Promise.resolve(false),
  verifyProvider: (_input: AiProviderVerifyInput) => Promise.resolve({ ok: true, modelCount: 0 }),
  setApiKey: (_providerId: string, _key: string) => Promise.resolve(),
  deleteApiKey: (_providerId: string) => Promise.resolve(),
  hasApiKey: (_providerId: string) => Promise.resolve(false),
  getRateTables: () => Promise.resolve([] as AiRateTableSnapshot[]),
  getAccountUsage: (_providerId: string) =>
    Promise.resolve(undefined as AiAccountUsage | undefined),
  refreshRemote: (_providerId?: string) => Promise.resolve(),
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
