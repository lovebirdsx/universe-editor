/*---------------------------------------------------------------------------------------------
 *  Tests for AiModelClientService — the renderer half of the chain: requestId-keyed
 *  chunk events reassembled into a clean AsyncIterable, cancellation routed back to
 *  main, serialized errors revived, and the renderer-owned active model id stored as
 *  the `ai.chat.model` setting (never in main / aiModels.json). Stubs the main
 *  transport and a minimal in-memory configuration service.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  CancellationTokenSource,
  ConfigurationTarget,
  Emitter,
  getTextResponse,
  transformErrorForSerialization,
  AiMessageRole,
  type AiMessage,
  type AiModelConfiguration,
  type AiProviderGroup,
  type IConfigurationService,
} from '@universe-editor/platform'
import { AiModelClientService } from '../aiModelClientService.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  IAiModelMainService,
} from '../../../../shared/ipc/aiModelService.js'

class FakeMain implements IAiModelMainService {
  declare readonly _serviceBrand: undefined

  readonly onDidEmitChunkEmitter = new Emitter<AiChunkEvent>()
  readonly onDidEndRequestEmitter = new Emitter<AiEndEvent>()
  readonly onDidChangeModelsEmitter = new Emitter<void>()
  readonly onDidEmitChunk = this.onDidEmitChunkEmitter.event
  readonly onDidEndRequest = this.onDidEndRequestEmitter.event
  readonly onDidChangeModels = this.onDidChangeModelsEmitter.event

  startedRequestId: string | undefined
  cancelledRequestId: string | undefined
  groups: readonly AiProviderGroup[] = []

  getModels() {
    return Promise.resolve([])
  }
  selectModels() {
    return Promise.resolve([])
  }
  computeTokenLength() {
    return Promise.resolve(0)
  }
  startRequest(requestId: string): Promise<void> {
    this.startedRequestId = requestId
    return Promise.resolve()
  }
  cancelRequest(requestId: string): Promise<void> {
    this.cancelledRequestId = requestId
    return Promise.resolve()
  }
  getModelConfiguration(): Promise<AiModelConfiguration> {
    return Promise.resolve({})
  }
  setModelConfiguration(): Promise<void> {
    return Promise.resolve()
  }
  getGroups(): Promise<readonly AiProviderGroup[]> {
    return Promise.resolve(this.groups)
  }
  updateGroups(groups: readonly AiProviderGroup[]): Promise<void> {
    this.groups = groups
    return Promise.resolve()
  }
  setApiKey(): Promise<void> {
    return Promise.resolve()
  }
  deleteApiKey(): Promise<void> {
    return Promise.resolve()
  }
  hasApiKey(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

class FakeConfig implements Partial<IConfigurationService> {
  readonly values = new Map<string, unknown>()
  private readonly _onDidChange = new Emitter<{ affectsConfiguration: (k: string) => boolean }>()
  readonly onDidChangeConfiguration = this._onDidChange.event

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }
  update(key: string, value: unknown, _target?: ConfigurationTarget): void {
    const old = this.values.get(key)
    this.values.set(key, value)
    if (old !== value) this._onDidChange.fire({ affectsConfiguration: (k) => k === key })
  }
}

const userMsg: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('AiModelClientService', () => {
  it('stores and reads the active model id through the ai.chat.model setting', async () => {
    const main = new FakeMain()
    const config = new FakeConfig()
    const client = new AiModelClientService(main, config as unknown as IConfigurationService)

    expect(await client.getActiveModelId()).toBeUndefined()

    await client.setActiveModelId('openai/default/gpt-4o')
    expect(await client.getActiveModelId()).toBe('openai/default/gpt-4o')
    expect(config.values.get('ai.chat.model')).toBe('openai/default/gpt-4o')

    // Clearing writes an empty string (so the key still round-trips through
    // settings.json) but reads back as undefined.
    await client.setActiveModelId(undefined)
    expect(config.values.get('ai.chat.model')).toBe('')
    expect(await client.getActiveModelId()).toBeUndefined()
    client.dispose()
  })

  it('fires onDidChangeActiveModel when the setting changes', async () => {
    const main = new FakeMain()
    const config = new FakeConfig()
    const client = new AiModelClientService(main, config as unknown as IConfigurationService)
    let fired = 0
    client.onDidChangeActiveModel(() => fired++)

    await client.setActiveModelId('openai/default/gpt-4o')
    await client.setActiveModelId(undefined)
    expect(fired).toBe(2)
    client.dispose()
  })

  it('reassembles chunk events keyed by requestId into a clean stream', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(
      main,
      new FakeConfig() as unknown as IConfigurationService,
    )

    const token = new CancellationTokenSource()
    const response = client.sendRequest(userMsg, { modelId: 'm' }, token.token)
    await flush()
    const id = main.startedRequestId!

    main.onDidEmitChunkEmitter.fire({ requestId: id, chunk: { type: 'text', value: 'Hel' } })
    main.onDidEmitChunkEmitter.fire({ requestId: 'other', chunk: { type: 'text', value: 'X' } })
    main.onDidEmitChunkEmitter.fire({ requestId: id, chunk: { type: 'text', value: 'lo' } })
    main.onDidEndRequestEmitter.fire({ requestId: id })

    const text = await getTextResponse(response)
    expect(text).toBe('Hello')
    client.dispose()
  })

  it('routes cancellation back to main with the same requestId', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(
      main,
      new FakeConfig() as unknown as IConfigurationService,
    )

    const token = new CancellationTokenSource()
    const response = client.sendRequest(userMsg, { modelId: 'm' }, token.token)
    await flush()
    const id = main.startedRequestId!

    token.cancel()
    expect(main.cancelledRequestId).toBe(id)

    // End the request so the stream settles and no rejection leaks.
    main.onDidEndRequestEmitter.fire({ requestId: id })
    await getTextResponse(response)
    client.dispose()
  })

  it('revives a serialized error from the end event into the result rejection', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(
      main,
      new FakeConfig() as unknown as IConfigurationService,
    )

    const token = new CancellationTokenSource()
    const response = client.sendRequest(userMsg, { modelId: 'm' }, token.token)
    await flush()
    const id = main.startedRequestId!

    main.onDidEndRequestEmitter.fire({
      requestId: id,
      error: transformErrorForSerialization(new Error('upstream failed')),
    })

    await expect(response.result).rejects.toThrow('upstream failed')
    client.dispose()
  })
})
