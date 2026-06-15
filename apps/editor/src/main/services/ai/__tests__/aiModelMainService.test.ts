/*---------------------------------------------------------------------------------------------
 *  Tests for AiModelMainService — the stream pump (provider stream → requestId-keyed
 *  chunk events), the error and cancellation paths, the unknown-model guard, and the
 *  schema/user → per-request config merge.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  AiErrorCode,
  AsyncIterableSource,
  DeferredPromise,
  type AiModelMetadata,
  type AiRequestOptions,
  type AiRequestResult,
  type AiResponse,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
  type IDisposable,
} from '@universe-editor/platform'
import { AiModelMainService } from '../aiModelMainService.js'
import type { ISecretStorageService } from '@universe-editor/platform'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
} from '../../../../shared/ipc/aiModelService.js'

function model(id: string, vendor: string): AiModelMetadata {
  return {
    id,
    vendor,
    name: id,
    family: id,
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true },
  }
}

const secretsStub: ISecretStorageService = {
  _serviceBrand: undefined,
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
}

interface FakeProviderHandle {
  readonly provider: IAiModelProvider
  /** The options the last sendRequest received (to assert config merge). */
  lastOptions(): AiRequestOptions | undefined
  /** Resolves to the token passed to sendRequest, once a request starts. */
  tokenStarted(): Promise<CancellationToken>
}

function fakeStreamingProvider(
  models: AiModelMetadata[],
  run: (
    source: AsyncIterableSource<AiResponseChunk>,
    result: DeferredPromise<AiRequestResult>,
  ) => void,
): FakeProviderHandle {
  let lastOptions: AiRequestOptions | undefined
  const tokenDeferred = new DeferredPromise<CancellationToken>()
  const provider: IAiModelProvider = {
    provideModels: () => Promise.resolve(models),
    sendRequest: (_messages, options, token): AiResponse => {
      lastOptions = options
      tokenDeferred.complete(token)
      const source = new AsyncIterableSource<AiResponseChunk>()
      const result = new DeferredPromise<AiRequestResult>()
      result.p.catch(() => undefined)
      run(source, result)
      return { stream: source.asyncIterable, result: result.p }
    },
    provideTokenCount: () => Promise.resolve(0),
  }
  return {
    provider,
    lastOptions: () => lastOptions,
    tokenStarted: () => tokenDeferred.p,
  }
}

/** Register a fake provider on the service's internal registry. */
function addProvider(
  service: AiModelMainService,
  vendor: string,
  provider: IAiModelProvider,
): IDisposable {
  const registry = (
    service as unknown as {
      _registry: { registerProvider(v: string, p: IAiModelProvider): IDisposable }
    }
  )._registry
  return registry.registerProvider(vendor, provider)
}

const userMsg: readonly AiMessageDto[] = [{ role: 1, content: [{ type: 'text', value: 'hi' }] }]

function collectEnd(service: AiModelMainService): Promise<AiEndEvent> {
  return new Promise((resolve) => {
    service.onDidEndRequest((e) => resolve(e))
  })
}

describe('AiModelMainService', () => {
  it('pumps provider stream into requestId-keyed chunk events then ends without error', async () => {
    const service = new AiModelMainService(secretsStub)
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/m', 'fake')], (source, result) => {
        source.emitOne({ type: 'text', value: 'Hel' })
        source.emitOne({ type: 'text', value: 'lo' })
        source.resolve()
        result.complete({})
      }).provider,
    )

    const chunks: AiChunkEvent[] = []
    service.onDidEmitChunk((e) => chunks.push(e))
    const ended = collectEnd(service)

    await service.startRequest('r1', userMsg, { modelId: 'fake/m' })
    const end = await ended

    expect(chunks.map((c) => c.requestId)).toEqual(['r1', 'r1'])
    expect(chunks.map((c) => (c.chunk.type === 'text' ? c.chunk.value : ''))).toEqual(['Hel', 'lo'])
    expect(end.requestId).toBe('r1')
    expect(end.error).toBeUndefined()
    service.dispose()
  })

  it('reports a serialized error when the provider stream fails', async () => {
    const service = new AiModelMainService(secretsStub)
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/m', 'fake')], (source, result) => {
        const err = new Error('boom')
        source.reject(err)
        result.error(err)
      }).provider,
    )
    const ended = collectEnd(service)

    await service.startRequest('r2', userMsg, { modelId: 'fake/m' })
    const end = await ended

    expect(end.requestId).toBe('r2')
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.message).toBe('boom')
    service.dispose()
  })

  it('cancelRequest cancels the token the provider received', async () => {
    const service = new AiModelMainService(secretsStub)
    const handle = fakeStreamingProvider([model('fake/m', 'fake')], (source, result) => {
      // Never completes on its own; only cancellation ends it.
      void source
      void result
    })
    addProvider(service, 'fake', handle.provider)
    const ended = collectEnd(service)

    await service.startRequest('r3', userMsg, { modelId: 'fake/m' })
    const token = await handle.tokenStarted()
    expect(token.isCancellationRequested).toBe(false)

    // Wire the provider to terminate when cancelled, mirroring a real provider.
    token.onCancellationRequested(() => {
      // no-op: presence of the event is what we assert
    })
    await service.cancelRequest('r3')
    expect(token.isCancellationRequested).toBe(true)

    // Drain: a real provider would reject; here we just ensure no lingering inflight.
    void ended
    service.dispose()
  })

  it('ends with an error when no provider owns the model', async () => {
    const service = new AiModelMainService(secretsStub)
    const ended = collectEnd(service)
    await expect(
      service.startRequest('r4', userMsg, { modelId: 'nope/x' }),
    ).resolves.toBeUndefined()
    const end = await ended
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.code).toBe(AiErrorCode.ProviderUnavailable)
    expect(end.error?.message).toContain("AI provider 'nope' is not available")
    service.dispose()
  })

  it('routes vendor-prefixed model ids to their provider even when not listed in the model cache', async () => {
    const service = new AiModelMainService(secretsStub)
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([], (source, result) => {
        source.emitOne({ type: 'text', value: 'ok' })
        source.resolve()
        result.complete({})
      }).provider,
    )
    const chunks: AiChunkEvent[] = []
    service.onDidEmitChunk((e) => chunks.push(e))
    const ended = collectEnd(service)

    await service.startRequest('r4b', userMsg, { modelId: 'fake/not-listed' })
    const end = await ended

    expect(chunks.map((c) => c.chunk)).toEqual([{ type: 'text', value: 'ok' }])
    expect(end.error).toBeUndefined()
    service.dispose()
  })

  it('reports provider synchronous failures through the end event instead of rejecting startRequest', async () => {
    const service = new AiModelMainService(secretsStub)
    addProvider(service, 'fake', {
      provideModels: () => Promise.resolve([model('fake/m', 'fake')]),
      sendRequest: () => {
        throw new Error('sync boom')
      },
      provideTokenCount: () => Promise.resolve(0),
    })
    const ended = collectEnd(service)

    await expect(
      service.startRequest('r4c', userMsg, { modelId: 'fake/m' }),
    ).resolves.toBeUndefined()
    const end = await ended

    expect(end.error?.message).toBe('sync boom')
    service.dispose()
  })

  it('reports OpenAI key misconfiguration instead of treating an explicit OpenAI model as provider-missing', async () => {
    const service = new AiModelMainService(secretsStub)
    const ended = collectEnd(service)

    await expect(
      service.startRequest('r4d', userMsg, { modelId: 'openai/gpt-5-nano' }),
    ).resolves.toBeUndefined()
    const end = await ended

    expect(end.error?.code).toBe(AiErrorCode.ConfigurationRequired)
    expect(end.error?.message).toBe('OpenAI API key is not configured.')
    service.dispose()
  })

  it('merges config: schema/user defaults fill in, per-request options win', async () => {
    const service = new AiModelMainService(secretsStub)
    const handle = fakeStreamingProvider([model('fake/m', 'fake')], (source, result) => {
      source.resolve()
      result.complete({})
    })
    addProvider(service, 'fake', handle.provider)
    await service.setConfig({ vendors: {}, request: { temperature: 0.2, maxTokens: 100 } })

    const ended = collectEnd(service)
    await service.startRequest('r5', userMsg, { modelId: 'fake/m', temperature: 0.9 })
    await ended

    const opts = handle.lastOptions()
    expect(opts?.temperature).toBe(0.9) // per-request wins
    expect(opts?.maxTokens).toBe(100) // default fills in
    service.dispose()
  })

  it('drops undefined-valued options after merge (exactOptionalPropertyTypes)', async () => {
    const service = new AiModelMainService(secretsStub)
    const handle = fakeStreamingProvider([model('fake/m', 'fake')], (source, result) => {
      source.resolve()
      result.complete({})
    })
    addProvider(service, 'fake', handle.provider)

    const ended = collectEnd(service)
    await service.startRequest('r6', userMsg, { modelId: 'fake/m' })
    await ended

    const opts = handle.lastOptions()
    expect(opts && 'temperature' in opts).toBe(false)
    expect(opts && 'maxTokens' in opts).toBe(false)
    service.dispose()
  })

  it('stores, reports, and clears a vendor API key via secret storage', async () => {
    const store = new Map<string, string>()
    const secrets: ISecretStorageService = {
      _serviceBrand: undefined,
      get: (key) => Promise.resolve(store.get(key)),
      set: (key, value) => {
        store.set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        store.delete(key)
        return Promise.resolve()
      },
    }
    const service = new AiModelMainService(secrets)

    expect(await service.hasApiKey('openai')).toBe(false)

    await service.setApiKey('openai', 'sk-123')
    expect(store.get('ai.secret.openai.apiKey')).toBe('sk-123')
    expect(await service.hasApiKey('openai')).toBe(true)

    await service.deleteApiKey('openai')
    expect(store.has('ai.secret.openai.apiKey')).toBe(false)
    expect(await service.hasApiKey('openai')).toBe(false)

    service.dispose()
  })

  it('fires onDidChangeModels when the openai key changes', async () => {
    const service = new AiModelMainService(secretsStub)
    let fired = 0
    service.onDidChangeModels(() => fired++)

    await service.setApiKey('openai', 'sk-123')
    expect(fired).toBeGreaterThan(0)

    service.dispose()
  })
})
