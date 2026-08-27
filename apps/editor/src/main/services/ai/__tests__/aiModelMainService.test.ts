/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AiModelMainService — the stream pump (provider stream → requestId-keyed
 *  chunk events), the error and cancellation paths, the unknown-model guard, the
 *  schema/user → per-request config merge, provider entry + apiKey persistence,
 *  active-model persistence, extends flattening, model-knowledge merge, endpoint
 *  discovery vs declared lists, per-provider pricing (catalog / http-json / none),
 *  legacy-format detection, and provider issues. Provider entries + active
 *  selections are read from a temp aiSettings.json.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AbstractLogger,
  AiErrorCode,
  AsyncIterableSource,
  CancellationError,
  DeferredPromise,
  Emitter,
  LogLevel,
  type AiRequestOptions,
  type AiRequestResult,
  type AiResponse,
  type AiResponseChunk,
  type AiWireProtocol,
  type CancellationToken,
  type IAiModelProvider,
  type ILoggerService,
} from '@universe-editor/platform'
import { AiDebugRecorder } from '../aiDebugRecorder.js'
import { AiModelMainService } from '../aiModelMainService.js'
import { AiRemoteCache } from '../remote/remoteCache.js'
import { IConfigLocationService } from '../../../../shared/ipc/configLocationService.js'
import type { LogMainService } from '../../log/logMainService.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
} from '../../../../shared/ipc/aiModelService.js'

/** A real wire protocol whose built-in provider is overwritten with the test fake. */
const FAKE_PROTOCOL: AiWireProtocol = 'ollama'

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

function makeService(providers: readonly unknown[]): AiModelMainService {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(join(dir, 'aiSettings.json'), JSON.stringify({ providers }), 'utf8')
  return new AiModelMainService(makeConfigLocation(dir), undefined, undefined, async () =>
    join(dir, 'ai-remote-cache'),
  )
}

/** Like makeService but writes a raw aiSettings.json body (for parse/legacy tests). */
function makeServiceFromFile(body: string): { service: AiModelMainService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(join(dir, 'aiSettings.json'), body, 'utf8')
  return {
    service: new AiModelMainService(makeConfigLocation(dir), undefined, undefined, async () =>
      join(dir, 'ai-remote-cache'),
    ),
    dir,
  }
}

interface FakeProviderHandle {
  readonly provider: IAiModelProvider
  listModelsCalls(): number
  lastOptions(): AiRequestOptions | undefined
  tokenStarted(): Promise<CancellationToken>
}

function fakeProvider(opts: {
  readonly models?: readonly string[]
  readonly run?: (
    source: AsyncIterableSource<AiResponseChunk>,
    result: DeferredPromise<AiRequestResult>,
  ) => void
}): FakeProviderHandle {
  let lastOptions: AiRequestOptions | undefined
  let listModelsCalls = 0
  const tokenDeferred = new DeferredPromise<CancellationToken>()
  const provider: IAiModelProvider = {
    listModels: () => {
      listModelsCalls++
      return Promise.resolve(opts.models ?? [])
    },
    sendRequest: (_messages, options, _runtime, token): AiResponse => {
      lastOptions = options
      tokenDeferred.complete(token)
      const source = new AsyncIterableSource<AiResponseChunk>()
      const result = new DeferredPromise<AiRequestResult>()
      result.p.catch(() => undefined)
      opts.run?.(source, result)
      return { stream: source.asyncIterable, result: result.p }
    },
    provideTokenCount: () => Promise.resolve(0),
  }
  return {
    provider,
    listModelsCalls: () => listModelsCalls,
    lastOptions: () => lastOptions,
    tokenStarted: () => tokenDeferred.p,
  }
}

/** A provider whose listModels only settles when its token is cancelled. */
function hangingListModels(started: DeferredPromise<CancellationToken>): IAiModelProvider {
  return {
    listModels: (_runtime, token: CancellationToken) =>
      new Promise<readonly string[]>((resolve) => {
        started.complete(token)
        token.onCancellationRequested(() => resolve([]))
      }),
    sendRequest: () => {
      throw new Error('unused')
    },
    provideTokenCount: () => Promise.resolve(0),
  }
}

/** Overwrite the registry's provider for a protocol with a test fake. */
function addProvider(
  service: AiModelMainService,
  protocol: AiWireProtocol,
  provider: IAiModelProvider,
): void {
  const registry = (
    service as unknown as {
      _registry: { _providers: Map<string, IAiModelProvider> }
    }
  )._registry
  registry._providers.set(protocol, provider)
}

/** Minimal fetch stand-ins for the /models probe (only the fields it reads). */
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function statusResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response
}

const userMsg: readonly AiMessageDto[] = [{ role: 1, content: [{ type: 'text', value: 'hi' }] }]

function collectEnd(service: AiModelMainService): Promise<AiEndEvent> {
  return new Promise((resolve) => {
    service.onDidEndRequest((e) => resolve(e))
  })
}

// Wait for the fire-and-forget JSONL append to land (file present AND a full
// line flushed — existsSync alone can race ahead of the write).
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes('\n')) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('AiModelMainService', () => {
  it('pumps provider stream into requestId-keyed chunk events then ends without error', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeProvider({
        run: (source, result) => {
          source.emitOne({ type: 'text', value: 'Hel' })
          source.emitOne({ type: 'text', value: 'lo' })
          source.resolve()
          result.complete({})
        },
      }).provider,
    )

    const chunks: AiChunkEvent[] = []
    service.onDidEmitChunk((e) => chunks.push(e))
    const ended = collectEnd(service)

    await service.startRequest('r1', userMsg, { modelId: 'fake/ollama/m' })
    const end = await ended

    expect(chunks.map((c) => c.requestId)).toEqual(['r1', 'r1'])
    expect(chunks.map((c) => (c.chunk.type === 'text' ? c.chunk.value : ''))).toEqual(['Hel', 'lo'])
    expect(end.requestId).toBe('r1')
    expect(end.error).toBeUndefined()
    service.dispose()
  })

  it('reports a serialized error when the provider stream fails', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeProvider({
        run: (source, result) => {
          const err = new Error('boom')
          source.reject(err)
          result.error(err)
        },
      }).provider,
    )
    const ended = collectEnd(service)

    await service.startRequest('r2', userMsg, { modelId: 'fake/ollama/m' })
    const end = await ended

    expect(end.requestId).toBe('r2')
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.message).toBe('boom')
    service.dispose()
  })

  it('logs a canceled request at info level, not warn', async () => {
    const entries: { level: LogLevel; message: string }[] = []
    class SpyLogger extends AbstractLogger {
      protected override _log(level: LogLevel, message: string): void {
        entries.push({ level, message })
      }
    }
    const spyLogger = new SpyLogger()
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({ providers: [{ id: 'fake', protocolMap: { ollama: ['m'] } }] }),
      'utf8',
    )
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      {
        _serviceBrand: undefined,
        createLogger: () => spyLogger,
        setLevel: (level: LogLevel) => spyLogger.setLevel(level),
        getLevel: () => spyLogger.level,
      },
      undefined,
      async () => join(dir, 'ai-remote-cache'),
    )
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeProvider({
        run: (source, result) => {
          const err = new CancellationError()
          source.reject(err)
          result.error(err)
        },
      }).provider,
    )
    const ended = collectEnd(service)

    await service.startRequest('r2c', userMsg, { modelId: 'fake/ollama/m' })
    await ended

    const entriesForRequest = entries.filter((e) => e.message.includes('r2c'))
    expect(entriesForRequest).toHaveLength(1)
    expect(entriesForRequest[0]!.level).toBe(LogLevel.Info)
    expect(entriesForRequest[0]!.message).toContain('canceled')
    service.dispose()
  })

  it('cancelRequest cancels the token the provider received', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    const handle = fakeProvider({})
    addProvider(service, FAKE_PROTOCOL, handle.provider)
    const ended = collectEnd(service)

    await service.startRequest('r3', userMsg, { modelId: 'fake/ollama/m' })
    const token = await handle.tokenStarted()
    expect(token.isCancellationRequested).toBe(false)

    await service.cancelRequest('r3')
    expect(token.isCancellationRequested).toBe(true)

    void ended
    service.dispose()
  })

  it('ends with an error when no provider owns the model', async () => {
    const service = makeService([])
    const ended = collectEnd(service)
    await expect(
      service.startRequest('r4', userMsg, { modelId: 'nope/openai-chat/x' }),
    ).resolves.toBeUndefined()
    const end = await ended
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.code).toBe(AiErrorCode.ProviderUnavailable)
    expect(end.error?.message).toContain("AI provider 'nope' is not available")
    service.dispose()
  })

  it('reports provider synchronous failures through the end event instead of rejecting startRequest', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    addProvider(service, FAKE_PROTOCOL, {
      listModels: () => Promise.resolve([]),
      sendRequest: () => {
        throw new Error('sync boom')
      },
      provideTokenCount: () => Promise.resolve(0),
    })
    const ended = collectEnd(service)

    await expect(
      service.startRequest('r4c', userMsg, { modelId: 'fake/ollama/m' }),
    ).resolves.toBeUndefined()
    const end = await ended

    expect(end.error?.message).toBe('sync boom')
    service.dispose()
  })

  it('merges config: stored modelSettings fill in, per-request options win', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    const handle = fakeProvider({
      run: (source, result) => {
        source.resolve()
        result.complete({})
      },
    })
    addProvider(service, FAKE_PROTOCOL, handle.provider)
    await service.setModelConfiguration('fake/ollama/m', { maxTokens: 100 })

    const ended = collectEnd(service)
    await service.startRequest('r5', userMsg, { modelId: 'fake/ollama/m', temperature: 0.9 })
    await ended

    const opts = handle.lastOptions()
    expect(opts?.temperature).toBe(0.9) // per-request passes through
    expect(opts?.modelConfiguration?.maxTokens).toBe(100) // stored setting fills in
    service.dispose()
  })

  it('exposes an empty model configuration when no settings are stored', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: ['m'] } }])
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)

    const config = await service.getModelConfiguration('fake/ollama/m')
    expect(config).toEqual({})
    service.dispose()
  })

  it('round-trips per-model configuration through top-level modelSettings', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ providers: [{ id: 'fake', protocolMap: { ollama: ['m'] } }] }),
    )
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)

    await service.setModelConfiguration('fake/ollama/m', { maxTokens: 256 })
    const config = await service.getModelConfiguration('fake/ollama/m')
    expect(config.maxTokens).toBe(256)

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.modelSettings['fake/ollama/m']).toEqual({ maxTokens: 256 })
    service.dispose()
  })

  it('removes a modelSettings entry when the config becomes empty', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'fake', protocolMap: { ollama: ['m'] } }],
        modelSettings: { 'fake/ollama/m': { maxTokens: 256 } },
      }),
    )
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)

    await service.setModelConfiguration('fake/ollama/m', {})
    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.modelSettings).toBeUndefined()
    service.dispose()
  })

  it('replaces persisted providers via updateProviders', async () => {
    const service = makeService([])
    await service.updateProviders([{ id: 'openai', baseUrl: 'http://localhost:1234/v1' }])
    const providers = await service.getProviders()
    expect(providers).toEqual([{ id: 'openai', baseUrl: 'http://localhost:1234/v1' }])
    service.dispose()
  })

  it('stores, reports, and clears an API key on the provider entry', async () => {
    const service = makeService([{ id: 'openai' }])

    expect(await service.hasApiKey('openai')).toBe(false)

    await service.setApiKey('openai', 'sk-123')
    expect(await service.hasApiKey('openai')).toBe(true)

    const providers = await service.getProviders()
    expect(providers.find((p) => p.id === 'openai')?.apiKey).toBe('sk-123')

    await service.deleteApiKey('openai')
    expect(await service.hasApiKey('openai')).toBe(false)

    // No auto-create: setting a key on a missing provider is a no-op.
    await service.setApiKey('missing', 'sk-456')
    expect(await service.hasApiKey('missing')).toBe(false)

    service.dispose()
  })

  it('fires onDidChangeModels when a key changes', async () => {
    const service = makeService([{ id: 'openai' }])
    let fired = 0
    service.onDidChangeModels(() => fired++)

    await service.setApiKey('openai', 'sk-123')
    expect(fired).toBeGreaterThan(0)

    service.dispose()
  })

  it('parses providers and activeModels from a top-level object', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        activeModels: {
          chat: 'openai/openai-chat/gpt-5.4',
          inlineCompletion: 'ollama/ollama/qwen2.5-coder',
        },
      }),
    )
    expect(await service.getActiveModel('chat')).toBe('openai/openai-chat/gpt-5.4')
    expect(await service.getActiveModel('inlineCompletion')).toBe('ollama/ollama/qwen2.5-coder')
    service.dispose()
  })

  it('parses and persists the commit and sessionTitle slots round-trip', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        activeModels: {
          commit: 'openai/openai-chat/gpt-5.4',
          sessionTitle: 'ollama/ollama/qwen2.5-coder',
        },
      }),
    )
    expect(await service.getActiveModel('commit')).toBe('openai/openai-chat/gpt-5.4')
    expect(await service.getActiveModel('sessionTitle')).toBe('ollama/ollama/qwen2.5-coder')

    await service.setActiveModel('sessionTitle', 'openai/openai-chat/gpt-5.4-mini')
    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.commit).toBe('openai/openai-chat/gpt-5.4')
    expect(onDisk.activeModels.sessionTitle).toBe('openai/openai-chat/gpt-5.4-mini')
    service.dispose()
  })

  it('yields no providers when the file is a bare array (not supported)', async () => {
    const { service } = makeServiceFromFile(JSON.stringify([{ id: 'openai' }]))
    const providers = await service.getProviders()
    expect(providers).toEqual([])
    expect(await service.getActiveModel('chat')).toBeUndefined()
    service.dispose()
  })

  it('persists setActiveModel into aiSettings.json and fires the change event', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      }),
    )
    const events: string[] = []
    service.onDidChangeActiveModel((e) => events.push(e.kind))

    await service.setActiveModel('chat', 'openai/openai-chat/gpt-5.4')
    expect(await service.getActiveModel('chat')).toBe('openai/openai-chat/gpt-5.4')
    expect(events).toEqual(['chat'])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/openai-chat/gpt-5.4')
    // Providers are preserved alongside the active selection.
    expect(onDisk.providers).toEqual([
      { id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } },
    ])
    service.dispose()
  })

  it('clears an active-model slot by deleting the key', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        activeModels: { chat: 'openai/openai-chat/gpt-5.4' },
      }),
    )
    await service.setActiveModel('chat', undefined)
    expect(await service.getActiveModel('chat')).toBeUndefined()

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels).toBeUndefined()
    service.dispose()
  })

  it('updateProviders preserves the active-model selections', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        activeModels: { chat: 'openai/openai-chat/gpt-5.4' },
      }),
    )
    await service.updateProviders([{ id: 'ollama' }])
    expect(await service.getActiveModel('chat')).toBe('openai/openai-chat/gpt-5.4')

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/openai-chat/gpt-5.4')
    expect(onDisk.providers).toEqual([{ id: 'ollama' }])
    service.dispose()
  })

  it('preserves agent authentication state when writing model settings', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        agentSettings: {
          claude: { authentication: 'acme-gbl', model: 'acme-chat-pro' },
          codex: { authentication: '@subscription', model: 'gpt-5.4' },
        },
      }),
    )

    await service.setActiveModel('chat', 'openai/openai-chat/gpt-5.4')

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.agentSettings.claude.authentication).toBe('acme-gbl')
    expect(onDisk.agentSettings.claude.model).toBe('acme-chat-pro')
    expect(onDisk.agentSettings.codex.authentication).toBe('@subscription')
    service.dispose()
  })

  it('cancels a metadata request whose provider never responds (no leak on a hung endpoint)', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: [] } }])
    const tokenStarted = new DeferredPromise<CancellationToken>()
    addProvider(service, FAKE_PROTOCOL, hangingListModels(tokenStarted))

    // Drain _ready (a real fs read) under real timers before faking the clock,
    // so the deadline timer is the only thing the fake clock has to advance.
    await service.getActiveModel('chat')

    vi.useFakeTimers()
    try {
      const modelsPromise = service.getModels()
      const token = await tokenStarted.p
      expect(token.isCancellationRequested).toBe(false)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(token.isCancellationRequested).toBe(true)
      await expect(modelsPromise).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
      service.dispose()
    }
  })

  it('cancels in-flight metadata requests on dispose (shutdown beats the deadline)', async () => {
    const service = makeService([{ id: 'fake', protocolMap: { ollama: [] } }])
    const tokenStarted = new DeferredPromise<CancellationToken>()
    addProvider(service, FAKE_PROTOCOL, hangingListModels(tokenStarted))

    const modelsPromise = service.getModels()
    const token = await tokenStarted.p
    expect(token.isCancellationRequested).toBe(false)

    // Quitting must tear the provider's abort pipeline down synchronously — the
    // 10s deadline never gets a chance to fire during shutdown.
    service.dispose()
    expect(token.isCancellationRequested).toBe(true)
    await expect(modelsPromise).resolves.toEqual([])
  })

  it('flattens extends so a child inherits the parent protocolMap', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          { id: 'acme', protocolMap: { ollama: ['acme-chat-pro'] } },
          { id: 'acme-gbl', extends: 'acme', baseUrl: 'http://192.0.2.31:8080/v1', apiKey: 'ak-1' },
        ],
      }),
    )
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)

    const models = await service.getModels()
    const ids = models.map((m) => m.id)
    expect(ids).toContain('acme/ollama/acme-chat-pro')
    expect(ids).toContain('acme-gbl/ollama/acme-chat-pro')
    service.dispose()
  })

  it('merges user model knowledge over the built-in base field-by-field', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        models: { 'gpt-5.4': { maxOutputTokens: 9999 } },
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      }),
    )

    const knowledge = await service.getModelKnowledge()
    const entry = knowledge['gpt-5.4']
    expect(entry?.maxOutputTokens).toBe(9999)
    // Field-level merge preserves the other built-in fields (e.g. vendor).
    expect(entry?.vendor).toBe('openai')
    service.dispose()
  })

  it('returns an empty user knowledge layer when no aiSettings.json exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      undefined,
      undefined,
      async () => join(dir, 'ai-remote-cache'),
    )

    expect(await service.getUserModelKnowledge()).toEqual({})
    service.dispose()
  })

  it('round-trips the user model knowledge layer', async () => {
    const service = makeService([])

    await service.updateModelKnowledge({ 'my-model': { name: 'X', maxInputTokens: 123 } })
    expect(await service.getUserModelKnowledge()).toEqual({
      'my-model': { name: 'X', maxInputTokens: 123 },
    })
    service.dispose()
  })

  it('persists only the user knowledge layer to disk, never the built-in keys', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      }),
    )

    await service.updateModelKnowledge({ 'my-model': { name: 'X', maxInputTokens: 123 } })

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(Object.keys(onDisk.models)).toEqual(['my-model'])
    expect(onDisk.models['claude-sonnet-5']).toBeUndefined()

    // The merged view keeps both the built-in and the user keys.
    const knowledge = await service.getModelKnowledge()
    expect(knowledge['claude-sonnet-5']).toBeDefined()
    expect(knowledge['my-model']).toEqual({ name: 'X', maxInputTokens: 123 })
    service.dispose()
  })

  it('removes the top-level models key when the user layer becomes empty', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        models: { 'my-model': { name: 'X', maxInputTokens: 123 } },
        providers: [],
      }),
    )

    await service.updateModelKnowledge({})
    expect(await service.getUserModelKnowledge()).toEqual({})

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.models).toBeUndefined()
    service.dispose()
  })

  it('updateModelKnowledge preserves providers, activeModels and modelSettings', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
        activeModels: { chat: 'openai/openai-chat/gpt-5.4' },
        modelSettings: { 'openai/openai-chat/gpt-5.4': { maxTokens: 256 } },
      }),
    )

    await service.updateModelKnowledge({ 'my-model': { name: 'X', maxInputTokens: 123 } })

    expect(await service.getProviders()).toEqual([
      { id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } },
    ])
    expect(await service.getActiveModel('chat')).toBe('openai/openai-chat/gpt-5.4')
    const config = await service.getModelConfiguration('openai/openai-chat/gpt-5.4')
    expect(config.maxTokens).toBe(256)

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.providers).toEqual([
      { id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } },
    ])
    expect(onDisk.activeModels.chat).toBe('openai/openai-chat/gpt-5.4')
    expect(onDisk.modelSettings['openai/openai-chat/gpt-5.4']).toEqual({ maxTokens: 256 })
    service.dispose()
  })

  it('writes the renamed knowledge key and the rewritten provider ref in one file write', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        models: { 'my-model': { name: 'X' } },
        providers: [
          { id: 'gw', protocolMap: { 'anthropic-messages': [{ id: 'wire', ref: 'my-model' }] } },
        ],
        activeModels: { chat: 'gw/anthropic-messages/wire' },
        modelSettings: { 'gw/anthropic-messages/wire': { maxTokens: 256 } },
      }),
    )

    // A rename touches both layers; split writes can fail in between and leave the
    // ref pointing at a key that no longer exists.
    await service.updateModelKnowledgeAndProviders({ 'my-model-2': { name: 'X' } }, [
      { id: 'gw', protocolMap: { 'anthropic-messages': [{ id: 'wire', ref: 'my-model-2' }] } },
    ])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(Object.keys(onDisk.models)).toEqual(['my-model-2'])
    expect(onDisk.providers).toEqual([
      { id: 'gw', protocolMap: { 'anthropic-messages': [{ id: 'wire', ref: 'my-model-2' }] } },
    ])
    expect(onDisk.activeModels.chat).toBe('gw/anthropic-messages/wire')
    expect(onDisk.modelSettings['gw/anthropic-messages/wire']).toEqual({ maxTokens: 256 })

    expect(await service.getUserModelKnowledge()).toEqual({ 'my-model-2': { name: 'X' } })
    expect(await service.getProviders()).toEqual([
      { id: 'gw', protocolMap: { 'anthropic-messages': [{ id: 'wire', ref: 'my-model-2' }] } },
    ])
    service.dispose()
  })

  it('returns an empty user knowledge layer for a legacy two-layer file', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providerTypes: { anthropic: { protocol: 'anthropic-messages' } },
        providers: [{ type: 'anthropic', name: 'default' }],
      }),
    )

    expect(await service.getUserModelKnowledge()).toEqual({})
    service.dispose()
  })

  it('enumerates models from the endpoint when protocolMap is [] (discover)', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({ providers: [{ id: 'ollama', protocolMap: { ollama: [] } }] }),
    )
    const handle = fakeProvider({ models: ['qwen2.5-coder', 'llama3.2'] })
    addProvider(service, FAKE_PROTOCOL, handle.provider)

    const models = await service.getModels()
    expect(handle.listModelsCalls()).toBeGreaterThan(0)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('ollama/ollama/qwen2.5-coder')
    expect(ids).toContain('ollama/ollama/llama3.2')
    service.dispose()
  })

  it('uses the declared model list verbatim and never touches the network', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'acme', protocolMap: { ollama: ['acme-chat-standard'] } }],
      }),
    )
    const handle = fakeProvider({ models: ['should-not-be-called'] })
    addProvider(service, FAKE_PROTOCOL, handle.provider)

    const models = await service.getModels()
    expect(handle.listModelsCalls()).toBe(0)
    expect(models.map((m) => m.id)).toEqual(['acme/ollama/acme-chat-standard'])
    service.dispose()
  })

  it('stamps catalog pricing for a provider with a catalog pricingSource', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          {
            id: 'anthropic-official',
            protocolMap: { 'anthropic-messages': ['claude-sonnet-5'] },
            pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
          },
        ],
      }),
    )

    const models = await service.getModels()
    const m = models.find((x) => x.id === 'anthropic-official/anthropic-messages/claude-sonnet-5')
    expect(m?.pricingOrigin).toBe('catalog')
    expect(m?.pricing).toEqual({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 })
    service.dispose()
  })

  it('stamps gateway pricing from the cached rate table for an http-json source', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          { id: 'acme', protocolMap: { ollama: ['m'] }, pricingSource: { id: 'http-json' } },
        ],
      }),
    )
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)
    const cache = (service as unknown as { _remoteCache: AiRemoteCache })._remoteCache
    cache.setRates('acme', { m: { input: 1, output: 2 } })

    const models = await service.getModels()
    const m = models.find((x) => x.id === 'acme/ollama/m')
    expect(m?.pricingOrigin).toBe('gateway')
    expect(m?.pricing).toEqual({ input: 1, output: 2 })
    service.dispose()
  })

  it('never lets a provider without pricingSource borrow another provider rate', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          { id: 'no-source', protocolMap: { ollama: ['m'] } },
          { id: 'sourced', protocolMap: { ollama: ['m'] }, pricingSource: { id: 'http-json' } },
        ],
      }),
    )
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: [] }).provider)
    const cache = (service as unknown as { _remoteCache: AiRemoteCache })._remoteCache
    cache.setRates('sourced', { m: { input: 1, output: 2 } })

    const models = await service.getModels()
    const unsourced = models.find((x) => x.id === 'no-source/ollama/m')
    const sourced = models.find((x) => x.id === 'sourced/ollama/m')
    expect(unsourced?.pricing).toBeUndefined()
    expect(unsourced?.pricingOrigin).toBeUndefined()
    expect(sourced?.pricing).toEqual({ input: 1, output: 2 })
    service.dispose()
  })

  it('detects a legacy two-layer file and returns an empty configuration without rewriting it', async () => {
    const body = JSON.stringify({
      providerTypes: { anthropic: { protocol: 'anthropic-messages' } },
      providers: [{ type: 'anthropic', name: 'default' }],
      activeModels: { chat: 'anthropic/default/claude-sonnet-5' },
    })
    const { service, dir } = makeServiceFromFile(body)

    expect(await service.isLegacySettingsFormat()).toBe(true)
    expect(await service.getProviders()).toEqual([])
    expect(await service.getActiveModel('chat')).toBeUndefined()
    // The legacy file is preserved byte-for-byte.
    expect(readFileSync(join(dir, 'aiSettings.json'), 'utf8')).toBe(body)
    service.dispose()
  })

  it('detects a legacy providers[].type and returns an empty configuration', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({ providers: [{ type: 'openai', name: 'default' }] }),
    )
    expect(await service.isLegacySettingsFormat()).toBe(true)
    expect(await service.getProviders()).toEqual([])
    service.dispose()
  })

  it('detects a legacy groups key and returns an empty configuration', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({ groups: [{ vendor: 'openai', name: 'default' }] }),
    )
    expect(await service.isLegacySettingsFormat()).toBe(true)
    expect(await service.getProviders()).toEqual([])
    service.dispose()
  })

  it('does not flag a well-formed single-layer file as legacy', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      }),
    )
    expect(await service.isLegacySettingsFormat()).toBe(false)
    service.dispose()
  })

  it('exposes provider issues from resolveProviderEntries', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          { id: 'orphan', extends: 'missing' },
          { id: 'no-protocol', baseUrl: 'http://localhost:1' },
        ],
      }),
    )

    const issues = await service.getProviderIssues()
    expect(issues).toContainEqual(
      expect.objectContaining({ providerId: 'orphan', reason: 'unknown-extends', fatal: true }),
    )
    expect(issues).toContainEqual(
      expect.objectContaining({ providerId: 'no-protocol', reason: 'no-protocol', fatal: true }),
    )
    service.dispose()
  })

  // An element that never became an entry has no card of its own, so without an
  // issue it would vanish from the settings page with no feedback whatsoever.
  it('reports an element that is not a well-formed entry, by its index', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [
          { id: 'good', protocolMap: { 'openai-chat': ['gpt-5.4'] } },
          { ib: 'typo', baseUrl: 'http://localhost:1' },
          'not-an-object',
        ],
      }),
    )

    expect((await service.getProviders()).map((p) => p.id)).toEqual(['good'])
    const issues = await service.getProviderIssues()
    expect(issues).toContainEqual({
      providerId: 'providers[1]',
      reason: 'malformed-entry',
      fatal: true,
    })
    expect(issues).toContainEqual({
      providerId: 'providers[2]',
      reason: 'malformed-entry',
      fatal: true,
    })
    service.dispose()
  })

  it('verifyProvider returns ok:false for an unregistered protocol', async () => {
    const service = makeService([])
    const result = await service.verifyProvider({
      id: 'x',
      protocol: 'no-such-protocol' as AiWireProtocol,
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('noProvider')
    service.dispose()
  })

  it('verifyProvider probes a provider via listModels and reports the count', async () => {
    const service = makeService([])
    addProvider(service, FAKE_PROTOCOL, fakeProvider({ models: ['a', 'b', 'c'] }).provider)
    const result = await service.verifyProvider({
      id: 'probe',
      protocol: FAKE_PROTOCOL as AiWireProtocol,
    })
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(3)
    service.dispose()
  })

  describe('verifyProvider failure classification', () => {
    // The agent panels probe with the agent's own protocol. `openai-responses`
    // gateways declare their models in protocolMap, so a reachable endpoint is a
    // pass even when it serves no model list — the regression this guards is a
    // permanently red "Test" dot on a perfectly working gateway.
    it('treats a reachable openai-responses gateway with an empty list as ok', async () => {
      const service = makeService([])
      const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const result = await service.verifyProvider({
          id: 'acme',
          protocol: 'openai-responses',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'k',
        })
        expect(result).toMatchObject({ ok: true, modelCount: 0 })
        expect(fetchMock).toHaveBeenCalledOnce()
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })

    it('treats 404 on /models as reachable for openai-responses', async () => {
      const service = makeService([])
      vi.stubGlobal('fetch', async () => statusResponse(404))
      try {
        const result = await service.verifyProvider({
          id: 'acme',
          protocol: 'openai-responses',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'k',
        })
        expect(result).toMatchObject({ ok: true, modelCount: 0 })
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })

    it('classifies 401 as unauthorized rather than "no models"', async () => {
      const service = makeService([])
      vi.stubGlobal('fetch', async () => statusResponse(401))
      try {
        const result = await service.verifyProvider({
          id: 'acme',
          protocol: 'openai-responses',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'wrong',
        })
        expect(result).toMatchObject({ ok: false, code: 'unauthorized', status: 401 })
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })

    it('classifies a 5xx as serverError', async () => {
      const service = makeService([])
      vi.stubGlobal('fetch', async () => statusResponse(503))
      try {
        const result = await service.verifyProvider({
          id: 'gw',
          protocol: 'openai-chat',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'k',
        })
        expect(result).toMatchObject({ ok: false, code: 'serverError', status: 503 })
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })

    it('classifies an unresolvable endpoint as unreachable', async () => {
      const service = makeService([])
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('fetch failed')
      })
      try {
        const result = await service.verifyProvider({
          id: 'gw',
          protocol: 'openai-responses',
          baseUrl: 'https://nope.invalid',
          apiKey: 'k',
        })
        expect(result).toMatchObject({ ok: false, code: 'unreachable' })
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })

    it('classifies a hung endpoint as timeout', async () => {
      const service = makeService([])
      const tokenStarted = new DeferredPromise<CancellationToken>()
      addProvider(service, FAKE_PROTOCOL, hangingListModels(tokenStarted))
      // Drain _ready under real timers so the deadline is all the fake clock drives.
      await service.getActiveModel('chat')

      vi.useFakeTimers()
      try {
        const pending = service.verifyProvider({ id: 'gw', protocol: FAKE_PROTOCOL })
        await tokenStarted.p
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await pending).toMatchObject({ ok: false, code: 'timeout' })
      } finally {
        vi.useRealTimers()
        service.dispose()
      }
    })

    // The relaxed judgement is scoped to openai-responses; enumerating protocols
    // must still report an empty 2xx list as "no models".
    it('still reports noModels for an enumerating protocol', async () => {
      const service = makeService([])
      vi.stubGlobal('fetch', async () => jsonResponse({ data: [] }))
      try {
        const result = await service.verifyProvider({
          id: 'gw',
          protocol: 'openai-chat',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'k',
        })
        expect(result).toMatchObject({ ok: false, code: 'noModels' })
      } finally {
        vi.unstubAllGlobals()
        service.dispose()
      }
    })
  })

  it('writes aiSettings.json with 0600 permissions', async () => {
    if (process.platform === 'win32') return
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      }),
    )
    await service.setActiveModel('chat', 'openai/openai-chat/x')
    const mode = statSync(join(dir, 'aiSettings.json')).mode & 0o777
    expect(mode).toBe(0o600)
    service.dispose()
  })

  it('does not rewrite a well-formed file on load', async () => {
    const body = JSON.stringify({
      providers: [{ id: 'openai', protocolMap: { 'openai-chat': ['gpt-5.4'] } }],
      activeModels: { chat: 'openai/openai-chat/gpt-5.4' },
    })
    const { service, dir } = makeServiceFromFile(body)
    const before = readFileSync(join(dir, 'aiSettings.json'), 'utf8')
    await service.getProviders()
    expect(readFileSync(join(dir, 'aiSettings.json'), 'utf8')).toBe(before)
    service.dispose()
  })

  it('never leaks a provider apiKey into AI debug records or logs', async () => {
    // Regression guard for the key-policy red line: the apiKey lives on the
    // provider runtime (AiProviderRuntime.apiKey), never in AiRequestOptions.
    const SENTINEL = 'sk-SENTINEL-MUST-NEVER-BE-RECORDED-9f3a'
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    const sessionDir = mkdtempSync(join(tmpdir(), 'ai-debug-session-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({
        providers: [{ id: 'fake', apiKey: SENTINEL, protocolMap: { ollama: ['m'] } }],
      }),
      'utf8',
    )

    const logEntries: string[] = []
    class SpyLogger extends AbstractLogger {
      protected override _log(_level: LogLevel, message: string): void {
        logEntries.push(message)
      }
    }
    const spyLogger = new SpyLogger()
    const logService: ILoggerService = {
      _serviceBrand: undefined,
      createLogger: () => spyLogger,
      setLevel: (level) => spyLogger.setLevel(level),
      getLevel: () => spyLogger.level,
    }

    const recorder = new AiDebugRecorder(
      { getSessionDir: () => sessionDir } as unknown as LogMainService,
      logService,
    )
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      logService,
      recorder,
      async () => join(dir, 'ai-remote-cache'),
    )

    // A fake provider that proves the key truly reached it, then streams a reply.
    let seenApiKey: string | undefined
    const provider: IAiModelProvider = {
      listModels: () => Promise.resolve([]),
      sendRequest: (_messages, _options, runtime, _token): AiResponse => {
        seenApiKey = runtime.apiKey
        const source = new AsyncIterableSource<AiResponseChunk>()
        const result = new DeferredPromise<AiRequestResult>()
        result.p.catch(() => undefined)
        source.emitOne({ type: 'text', value: 'hello from the fake model' })
        source.resolve()
        result.complete({})
        return { stream: source.asyncIterable, result: result.p }
      },
      provideTokenCount: () => Promise.resolve(0),
    }
    addProvider(service, FAKE_PROTOCOL, provider)

    const ended = collectEnd(service)
    await service.startRequest('secret-guard', userMsg, { modelId: 'fake/ollama/m' })
    await ended

    // The test is wired end-to-end: the key actually flowed into the provider's
    // hands — otherwise "no key recorded" could pass because the key never moved.
    expect(seenApiKey).toBe(SENTINEL)

    // The request was really recorded (JSONL) and logged (channel), so a missing
    // key can't be an artifact of nothing being written at all.
    const path = join(sessionDir, 'ai-debug.jsonl')
    await waitForFile(path)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('secret-guard')
    expect(content).toContain('hello from the fake model')
    const logText = logEntries.join('\n')
    expect(logText).toContain('secret-guard')

    // Neither the structured JSONL nor the human-readable channel leaks the key.
    expect(content).not.toContain(SENTINEL)
    expect(logText).not.toContain(SENTINEL)

    // The renderer-facing IPC projections (listRecords summary + getRecord full
    // record) must be key-free too — these are what the AI Debug panel sees.
    const summaries = recorder.listRecords()
    expect(summaries).toHaveLength(1)
    expect(JSON.stringify(summaries)).not.toContain(SENTINEL)
    const full = recorder.getRecord(summaries[0]!.id)
    expect(JSON.stringify(full)).not.toContain(SENTINEL)

    recorder.dispose()
    service.dispose()
  })
})
