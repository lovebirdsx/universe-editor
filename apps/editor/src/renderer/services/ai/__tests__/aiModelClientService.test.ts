/*---------------------------------------------------------------------------------------------
 *  Tests for AiModelClientService — the renderer half of the chain: requestId-keyed
 *  chunk events reassembled into a clean AsyncIterable, cancellation routed back to
 *  main, serialized errors revived, and the non-secret config push on construct +
 *  on ai.* changes. Stubs the main transport; uses the real ConfigurationService.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  CancellationTokenSource,
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  getTextResponse,
  transformErrorForSerialization,
  AiMessageRole,
  type AiMessage,
} from '@universe-editor/platform'
import { AiModelClientService } from '../aiModelClientService.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiResolvedConfigDto,
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

  configs: AiResolvedConfigDto[] = []
  startedRequestId: string | undefined
  cancelledRequestId: string | undefined

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
  setConfig(config: AiResolvedConfigDto): Promise<void> {
    this.configs.push(config)
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

const userMsg: readonly AiMessage[] = [
  { role: AiMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
]

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('AiModelClientService', () => {
  it('pushes resolved non-secret config on construct', async () => {
    const config = new ConfigurationService()
    config.update('ai.ollama.baseUrl', 'http://localhost:9', ConfigurationTarget.User)
    config.update('ai.request.temperature', 0.5, ConfigurationTarget.User)
    const main = new FakeMain()
    const client = new AiModelClientService(main, config)
    await flush()

    expect(main.configs.length).toBeGreaterThanOrEqual(1)
    const last = main.configs[main.configs.length - 1]!
    expect(last.vendors.ollama?.baseUrl).toBe('http://localhost:9')
    expect(last.request.temperature).toBe(0.5)
    client.dispose()
    config.dispose()
  })

  it('re-pushes config when ai.* settings change', async () => {
    const config = new ConfigurationService()
    const main = new FakeMain()
    const client = new AiModelClientService(main, config)
    await flush()
    const before = main.configs.length

    config.update('ai.openai.defaultModel', 'gpt-4o', ConfigurationTarget.User)
    await flush()
    expect(main.configs.length).toBeGreaterThan(before)
    expect(main.configs[main.configs.length - 1]!.vendors.openai?.defaultModel).toBe('gpt-4o')
    client.dispose()
    config.dispose()
  })

  it('reassembles chunk events keyed by requestId into a clean stream', async () => {
    const config = new ConfigurationService()
    const main = new FakeMain()
    const client = new AiModelClientService(main, config)

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
    config.dispose()
  })

  it('routes cancellation back to main with the same requestId', async () => {
    const config = new ConfigurationService()
    const main = new FakeMain()
    const client = new AiModelClientService(main, config)

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
    config.dispose()
  })

  it('revives a serialized error from the end event into the result rejection', async () => {
    const config = new ConfigurationService()
    const main = new FakeMain()
    const client = new AiModelClientService(main, config)

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
    config.dispose()
  })
})
