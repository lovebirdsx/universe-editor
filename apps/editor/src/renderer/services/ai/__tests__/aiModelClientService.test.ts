/*---------------------------------------------------------------------------------------------
 *  Tests for AiModelClientService — the renderer half of the chain: requestId-keyed
 *  chunk events reassembled into a clean AsyncIterable, cancellation routed back to
 *  main, serialized errors revived, and the active model selections proxied to main
 *  (persisted in aiSettings.json). Stubs the main transport.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  CancellationTokenSource,
  Emitter,
  getTextResponse,
  transformErrorForSerialization,
  AiMessageRole,
  type AiMessage,
  type AiModelConfiguration,
  type AiProviderGroup,
  type IDisposable,
} from '@universe-editor/platform'
import { AiModelClientService } from '../aiModelClientService.js'
import type {
  AiActiveModelChangeEvent,
  AiChunkEvent,
  AiEndEvent,
  IAiModelMainService,
} from '../../../../shared/ipc/aiModelService.js'
import type { AiActiveModelKind } from '@universe-editor/platform'

class FakeMain implements IAiModelMainService {
  declare readonly _serviceBrand: undefined

  readonly onDidEmitChunkEmitter = new Emitter<AiChunkEvent>()
  readonly onDidEndRequestEmitter = new Emitter<AiEndEvent>()
  readonly onDidChangeModelsEmitter = new Emitter<void>()
  readonly onDidChangeActiveModelEmitter = new Emitter<AiActiveModelChangeEvent>()

  // Wrap the chunk/end events so tests can observe whether the transport
  // subscriptions a request creates get disposed.
  readonly transportSubs: { disposed: boolean }[] = []
  private _wrapEvent<T>(event: (listener: (e: T) => void) => IDisposable) {
    return (listener: (e: T) => void): IDisposable => {
      const inner = event(listener)
      const tracked = {
        disposed: false,
        dispose() {
          if (!tracked.disposed) {
            tracked.disposed = true
            inner.dispose()
          }
        },
      }
      this.transportSubs.push(tracked)
      return tracked
    }
  }
  readonly onDidEmitChunk = this._wrapEvent(this.onDidEmitChunkEmitter.event)
  readonly onDidEndRequest = this._wrapEvent(this.onDidEndRequestEmitter.event)

  readonly onDidChangeModels = this.onDidChangeModelsEmitter.event
  readonly onDidChangeActiveModel = this.onDidChangeActiveModelEmitter.event

  startedRequestId: string | undefined
  cancelledRequestId: string | undefined
  groups: readonly AiProviderGroup[] = []
  readonly activeModels: {
    chat?: string
    inlineCompletion?: string
    commit?: string
    sessionTitle?: string
  } = {}

  getModels() {
    return Promise.resolve([])
  }
  selectModels() {
    return Promise.resolve([])
  }
  computeTokenLength() {
    return Promise.resolve(0)
  }
  getActiveModel(kind: AiActiveModelKind): Promise<string | undefined> {
    return Promise.resolve(this.activeModels[kind])
  }
  setActiveModel(kind: AiActiveModelKind, modelId: string | undefined): Promise<void> {
    if (modelId === undefined) delete this.activeModels[kind]
    else this.activeModels[kind] = modelId
    this.onDidChangeActiveModelEmitter.fire({ kind })
    return Promise.resolve()
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
  getVendors() {
    return Promise.resolve([])
  }
  verifyGroup() {
    return Promise.resolve({ ok: true, modelCount: 0 })
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
  it('proxies the active chat model id to main (persisted in aiSettings.json)', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)

    expect(await client.getActiveModelId()).toBeUndefined()

    await client.setActiveModelId('openai/default/gpt-4o')
    expect(await client.getActiveModelId()).toBe('openai/default/gpt-4o')
    expect(main.activeModels.chat).toBe('openai/default/gpt-4o')

    await client.setActiveModelId(undefined)
    expect(main.activeModels.chat).toBeUndefined()
    expect(await client.getActiveModelId()).toBeUndefined()
    client.dispose()
  })

  it('proxies the inline-completion model id to main, independent of chat', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)

    await client.setInlineCompletionModelId('ollama/default/qwen2.5-coder')
    expect(await client.getInlineCompletionModelId()).toBe('ollama/default/qwen2.5-coder')
    expect(main.activeModels.inlineCompletion).toBe('ollama/default/qwen2.5-coder')
    // The chat slot is untouched.
    expect(await client.getActiveModelId()).toBeUndefined()
    client.dispose()
  })

  it('dispatches main change events to the matching facade event by kind', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)
    let chat = 0
    let inline = 0
    client.onDidChangeActiveModel(() => chat++)
    client.onDidChangeInlineCompletionModel(() => inline++)

    main.onDidChangeActiveModelEmitter.fire({ kind: 'chat' })
    expect(chat).toBe(1)
    expect(inline).toBe(0)

    main.onDidChangeActiveModelEmitter.fire({ kind: 'inlineCompletion' })
    expect(chat).toBe(1)
    expect(inline).toBe(1)
    client.dispose()
  })

  it('reassembles chunk events keyed by requestId into a clean stream', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)

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
    const client = new AiModelClientService(main)

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
    const client = new AiModelClientService(main)

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

  // Regression: a window reload with a request still in flight reported the
  // chunk/end/cancel subscriptions as leaked disposables — they must be rooted
  // under the client so disposing it (or the singleton root) releases them.
  it('releases transport subscriptions of an in-flight request on dispose', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)

    const token = new CancellationTokenSource()
    const response = client.sendRequest(userMsg, { modelId: 'm' }, token.token)
    response.result.catch(() => undefined)
    await flush()
    expect(main.transportSubs.length).toBe(2)
    expect(main.transportSubs.every((s) => !s.disposed)).toBe(true)

    // No end event: the request is still in flight when the owner goes away.
    client.dispose()
    expect(main.transportSubs.every((s) => s.disposed)).toBe(true)
  })

  it('drops the request subscriptions from the client store once the stream ends', async () => {
    const main = new FakeMain()
    const client = new AiModelClientService(main)
    const storeSize = () =>
      (client as unknown as { _store: { _toDispose: Set<IDisposable> } })._store._toDispose.size
    const before = storeSize()

    const token = new CancellationTokenSource()
    const response = client.sendRequest(userMsg, { modelId: 'm' }, token.token)
    await flush()
    expect(storeSize()).toBe(before + 1)

    main.onDidEndRequestEmitter.fire({ requestId: main.startedRequestId! })
    await getTextResponse(response)
    expect(main.transportSubs.every((s) => s.disposed)).toBe(true)
    expect(storeSize()).toBe(before)
    client.dispose()
  })
})
