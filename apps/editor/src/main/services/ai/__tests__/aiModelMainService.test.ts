/*---------------------------------------------------------------------------------------------
 *  Tests for AiModelMainService — the stream pump (provider stream → requestId-keyed
 *  chunk events), the error and cancellation paths, the unknown-model guard, the
 *  schema/user → per-request config merge, group persistence, active-model
 *  persistence, and per-(vendor,group) secret storage. Provider groups + active
 *  selections are read from a temp aiSettings.json.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AiErrorCode,
  AsyncIterableSource,
  DeferredPromise,
  Emitter,
  type AiModelMetadata,
  type AiProviderGroup,
  type AiRequestOptions,
  type AiRequestResult,
  type AiResolvedGroup,
  type AiResponse,
  type AiResponseChunk,
  type CancellationToken,
  type IAiModelProvider,
  type IDisposable,
  type ISecretStorageService,
} from '@universe-editor/platform'
import { AiModelMainService } from '../aiModelMainService.js'
import { IConfigLocationService } from '../../../../shared/ipc/configLocationService.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
} from '../../../../shared/ipc/aiModelService.js'

function model(id: string): AiModelMetadata {
  const parts = id.split('/')
  return {
    id,
    vendor: parts[0]!,
    ...(parts[1] !== undefined ? { groupName: parts[1] } : {}),
    name: parts.slice(2).join('/') || id,
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

function makeConfigLocation(dir: string): IConfigLocationService {
  const emitter = new Emitter<string>()
  return {
    _serviceBrand: undefined,
    onDidChangeConfigDir: emitter.event,
    getInfo: () => Promise.resolve({ dir, origin: 'default', locked: false }),
    setConfigDir: () => Promise.resolve(false),
    resetToDefault: () => Promise.resolve(false),
    isDirNonEmpty: () => Promise.resolve(false),
  }
}

function makeService(
  groups: readonly AiProviderGroup[],
  secrets: ISecretStorageService = secretsStub,
): AiModelMainService {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(join(dir, 'aiSettings.json'), JSON.stringify({ groups }), 'utf8')
  return new AiModelMainService(secrets, makeConfigLocation(dir))
}

/** Like makeService but writes a raw aiSettings.json body (for parse tests). */
function makeServiceFromFile(body: string): { service: AiModelMainService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(join(dir, 'aiSettings.json'), body, 'utf8')
  return { service: new AiModelMainService(secretsStub, makeConfigLocation(dir)), dir }
}

const FAKE_GROUP: AiProviderGroup = { vendor: 'fake', name: 'default' }

interface FakeProviderHandle {
  readonly provider: IAiModelProvider
  lastOptions(): AiRequestOptions | undefined
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
    provideModels: (_group: AiResolvedGroup) => Promise.resolve(models),
    sendRequest: (_messages, options, _group, token): AiResponse => {
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
    const service = makeService([FAKE_GROUP])
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/default/m')], (source, result) => {
        source.emitOne({ type: 'text', value: 'Hel' })
        source.emitOne({ type: 'text', value: 'lo' })
        source.resolve()
        result.complete({})
      }).provider,
    )

    const chunks: AiChunkEvent[] = []
    service.onDidEmitChunk((e) => chunks.push(e))
    const ended = collectEnd(service)

    await service.startRequest('r1', userMsg, { modelId: 'fake/default/m' })
    const end = await ended

    expect(chunks.map((c) => c.requestId)).toEqual(['r1', 'r1'])
    expect(chunks.map((c) => (c.chunk.type === 'text' ? c.chunk.value : ''))).toEqual(['Hel', 'lo'])
    expect(end.requestId).toBe('r1')
    expect(end.error).toBeUndefined()
    service.dispose()
  })

  it('reports a serialized error when the provider stream fails', async () => {
    const service = makeService([FAKE_GROUP])
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/default/m')], (source, result) => {
        const err = new Error('boom')
        source.reject(err)
        result.error(err)
      }).provider,
    )
    const ended = collectEnd(service)

    await service.startRequest('r2', userMsg, { modelId: 'fake/default/m' })
    const end = await ended

    expect(end.requestId).toBe('r2')
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.message).toBe('boom')
    service.dispose()
  })

  it('cancelRequest cancels the token the provider received', async () => {
    const service = makeService([FAKE_GROUP])
    const handle = fakeStreamingProvider([model('fake/default/m')], (source, result) => {
      void source
      void result
    })
    addProvider(service, 'fake', handle.provider)
    const ended = collectEnd(service)

    await service.startRequest('r3', userMsg, { modelId: 'fake/default/m' })
    const token = await handle.tokenStarted()
    expect(token.isCancellationRequested).toBe(false)

    await service.cancelRequest('r3')
    expect(token.isCancellationRequested).toBe(true)

    void ended
    service.dispose()
  })

  it('ends with an error when no provider owns the model', async () => {
    const service = makeService([{ vendor: 'nope', name: 'default' }])
    const ended = collectEnd(service)
    await expect(
      service.startRequest('r4', userMsg, { modelId: 'nope/default/x' }),
    ).resolves.toBeUndefined()
    const end = await ended
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.code).toBe(AiErrorCode.ProviderUnavailable)
    expect(end.error?.message).toContain("AI provider 'nope' is not available")
    service.dispose()
  })

  it('reports provider synchronous failures through the end event instead of rejecting startRequest', async () => {
    const service = makeService([FAKE_GROUP])
    addProvider(service, 'fake', {
      provideModels: () => Promise.resolve([model('fake/default/m')]),
      sendRequest: () => {
        throw new Error('sync boom')
      },
      provideTokenCount: () => Promise.resolve(0),
    })
    const ended = collectEnd(service)

    await expect(
      service.startRequest('r4c', userMsg, { modelId: 'fake/default/m' }),
    ).resolves.toBeUndefined()
    const end = await ended

    expect(end.error?.message).toBe('sync boom')
    service.dispose()
  })

  it('merges config: group settings fill in, per-request options win', async () => {
    const service = makeService([
      { vendor: 'fake', name: 'default', settings: { 'fake/default/m': { maxTokens: 100 } } },
    ])
    const handle = fakeStreamingProvider([model('fake/default/m')], (source, result) => {
      source.resolve()
      result.complete({})
    })
    addProvider(service, 'fake', handle.provider)

    const ended = collectEnd(service)
    await service.startRequest('r5', userMsg, { modelId: 'fake/default/m', temperature: 0.9 })
    await ended

    const opts = handle.lastOptions()
    expect(opts?.temperature).toBe(0.9) // per-request passes through
    expect(opts?.modelConfiguration?.maxTokens).toBe(100) // group setting fills in
    service.dispose()
  })

  it('exposes an empty model configuration when no settings are stored', async () => {
    const service = makeService([FAKE_GROUP])
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/default/m')], () => undefined).provider,
    )

    const config = await service.getModelConfiguration('fake/default/m')
    expect(config).toEqual({})
    service.dispose()
  })

  it('round-trips per-model configuration through aiSettings.json', async () => {
    const service = makeService([FAKE_GROUP])
    addProvider(
      service,
      'fake',
      fakeStreamingProvider([model('fake/default/m')], () => undefined).provider,
    )

    await service.setModelConfiguration('fake/default/m', { maxTokens: 256 })
    const config = await service.getModelConfiguration('fake/default/m')
    expect(config.maxTokens).toBe(256)

    const groups = await service.getGroups()
    const group = groups.find((g) => g.vendor === 'fake' && g.name === 'default')
    expect(group?.settings?.['fake/default/m']).toEqual({ maxTokens: 256 })
    service.dispose()
  })

  it('replaces persisted groups via updateGroups', async () => {
    const service = makeService([FAKE_GROUP])
    await service.updateGroups([
      { vendor: 'openai', name: 'custom', baseUrl: 'http://localhost:1234/v1' },
    ])
    const groups = await service.getGroups()
    expect(groups).toEqual([
      { vendor: 'openai', name: 'custom', baseUrl: 'http://localhost:1234/v1' },
    ])
    service.dispose()
  })

  it('stores, reports, and clears an API key per (vendor, group) via secret storage', async () => {
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
    const service = makeService([{ vendor: 'openai', name: 'default' }], secrets)

    expect(await service.hasApiKey('openai', 'default')).toBe(false)

    await service.setApiKey('openai', 'default', 'sk-123')
    expect(store.get('ai.secret.openai.default.apiKey')).toBe('sk-123')
    expect(await service.hasApiKey('openai', 'default')).toBe(true)

    await service.deleteApiKey('openai', 'default')
    expect(store.has('ai.secret.openai.default.apiKey')).toBe(false)
    expect(await service.hasApiKey('openai', 'default')).toBe(false)

    service.dispose()
  })

  it('fires onDidChangeModels when a key changes', async () => {
    const service = makeService([{ vendor: 'openai', name: 'default' }])
    let fired = 0
    service.onDidChangeModels(() => fired++)

    await service.setApiKey('openai', 'default', 'sk-123')
    expect(fired).toBeGreaterThan(0)

    service.dispose()
  })

  it('parses groups and activeModels from a top-level object', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        groups: [{ vendor: 'openai', name: 'default' }],
        activeModels: { chat: 'openai/default/gpt-4o', inlineCompletion: 'ollama/default/qc' },
      }),
    )
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')
    expect(await service.getActiveModel('inlineCompletion')).toBe('ollama/default/qc')
    service.dispose()
  })

  it('falls back to default groups when the file is a bare array (no longer supported)', async () => {
    const { service } = makeServiceFromFile(JSON.stringify([{ vendor: 'openai', name: 'default' }]))
    const groups = await service.getGroups()
    // A top-level array is rejected → default ollama/openai groups synthesized.
    expect(groups.length).toBe(2)
    expect(await service.getActiveModel('chat')).toBeUndefined()
    service.dispose()
  })

  it('persists setActiveModel into aiSettings.json and fires the change event', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ groups: [{ vendor: 'openai', name: 'default' }] }),
    )
    const events: string[] = []
    service.onDidChangeActiveModel((e) => events.push(e.kind))

    await service.setActiveModel('chat', 'openai/default/gpt-4o')
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')
    expect(events).toEqual(['chat'])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/default/gpt-4o')
    // Groups are preserved alongside the active selection.
    expect(onDisk.groups).toEqual([{ vendor: 'openai', name: 'default' }])
    service.dispose()
  })

  it('clears an active-model slot by deleting the key', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        groups: [{ vendor: 'openai', name: 'default' }],
        activeModels: { chat: 'openai/default/gpt-4o' },
      }),
    )
    await service.setActiveModel('chat', undefined)
    expect(await service.getActiveModel('chat')).toBeUndefined()

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    // No active selections left → the activeModels key is omitted entirely.
    expect(onDisk.activeModels).toBeUndefined()
    service.dispose()
  })

  it('updateGroups preserves the active-model selections', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        groups: [{ vendor: 'openai', name: 'default' }],
        activeModels: { chat: 'openai/default/gpt-4o' },
      }),
    )
    await service.updateGroups([{ vendor: 'ollama', name: 'default' }])
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/default/gpt-4o')
    expect(onDisk.groups).toEqual([{ vendor: 'ollama', name: 'default' }])
    service.dispose()
  })

  it('cancels a metadata request whose provider never responds (no leak on a hung endpoint)', async () => {
    // Regression: getModels has no per-call deadline, so a provider whose fetch
    // never settles leaves its abort store + cancellation listener pending until
    // the process exits (reported as a main-process Disposable leak). The
    // _withTimeoutToken deadline must cancel the token so the provider unwinds.
    const service = makeService([FAKE_GROUP])
    const tokenStarted = new DeferredPromise<CancellationToken>()
    addProvider(service, 'fake', {
      // Hangs until cancelled, then resolves empty — mirrors a provider that
      // aborts its fetch on token cancellation and falls back to no models.
      provideModels: (_group: AiResolvedGroup, token: CancellationToken) =>
        new Promise<AiModelMetadata[]>((resolve) => {
          tokenStarted.complete(token)
          token.onCancellationRequested(() => resolve([]))
        }),
      sendRequest: () => {
        throw new Error('unused')
      },
      provideTokenCount: () => Promise.resolve(0),
    })

    // Drain _ready (a real fs read) under real timers before faking the clock,
    // so the deadline timer is the only thing the fake clock has to advance.
    await service.getActiveModel('chat')

    vi.useFakeTimers()
    try {
      const modelsPromise = service.getModels()
      const token = await tokenStarted.p
      expect(token.isCancellationRequested).toBe(false)

      // Crossing the deadline must cancel the token and let getModels settle.
      // Advance past the service's metadata deadline (10s) by a safe margin.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(token.isCancellationRequested).toBe(true)
      await expect(modelsPromise).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })
})
