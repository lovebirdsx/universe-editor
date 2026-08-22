/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AiModelMainService — the stream pump (provider stream → requestId-keyed
 *  chunk events), the error and cancellation paths, the unknown-model guard, the
 *  schema/user → per-request config merge, instance persistence, active-model
 *  persistence, per-(type,name) apiKey storage, legacy-shape migration, and remote
 *  gateway-rate overlay. Provider instances + active selections are read from a
 *  temp aiSettings.json.
 *--------------------------------------------------------------------------------------------*/

import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  type AiModelMetadata,
  type AiProviderInstance,
  type AiRequestOptions,
  type AiRequestResult,
  type AiResponse,
  type AiResponseChunk,
  type AiWireProtocol,
  type CancellationToken,
  type IAiModelProvider,
  type IDisposable,
  type ILoggerService,
} from '@universe-editor/platform'
import { AiDebugRecorder } from '../aiDebugRecorder.js'
import { AiModelMainService } from '../aiModelMainService.js'
import { AiRemoteCache } from '../remote/remoteCache.js'
import { updateAiSettingsAgentState } from '../aiSettingsAgentState.js'
import { IConfigLocationService } from '../../../../shared/ipc/configLocationService.js'
import type { LogMainService } from '../../log/logMainService.js'
import type { Storage } from '../../../storage.js'
import type {
  AiChunkEvent,
  AiEndEvent,
  AiMessageDto,
} from '../../../../shared/ipc/aiModelService.js'

/** Non-builtin protocol so the fake provider doesn't clash with the built-ins. */
const FAKE_PROTOCOL = 'x-fake'

const FAKE_INSTANCE: AiProviderInstance = { type: 'fake', name: 'default' }

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

function makeStorage(initial?: Record<string, unknown>): Storage {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}))
  return {
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    set: (key: string, value: unknown) => {
      data.set(key, value)
      return Promise.resolve()
    },
    remove: (key: string) => {
      data.delete(key)
      return Promise.resolve()
    },
    flush: () => Promise.resolve(),
    flushSync: () => {},
  }
}

function makeService(providers: readonly AiProviderInstance[]): AiModelMainService {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(
    join(dir, 'aiSettings.json'),
    JSON.stringify({
      providers,
      providerTypes: { fake: { protocol: FAKE_PROTOCOL } },
    }),
    'utf8',
  )
  return new AiModelMainService(makeConfigLocation(dir))
}

/** Like makeService but writes a raw aiSettings.json body (for parse/migration tests). */
function makeServiceFromFile(body: string): { service: AiModelMainService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
  writeFileSync(join(dir, 'aiSettings.json'), body, 'utf8')
  return { service: new AiModelMainService(makeConfigLocation(dir)), dir }
}

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
    provideModels: () => Promise.resolve(models),
    sendRequest: (_messages, options, _resolved, token): AiResponse => {
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

/** Register a fake provider on the service's internal registry under a fake protocol. */
function addProvider(
  service: AiModelMainService,
  protocol: string,
  provider: IAiModelProvider,
): IDisposable {
  const registry = (
    service as unknown as {
      _registry: { registerProvider(p: AiWireProtocol, prov: IAiModelProvider): IDisposable }
    }
  )._registry
  return registry.registerProvider(protocol as AiWireProtocol, provider)
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
    const service = makeService([FAKE_INSTANCE])
    addProvider(
      service,
      FAKE_PROTOCOL,
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
    const service = makeService([FAKE_INSTANCE])
    addProvider(
      service,
      FAKE_PROTOCOL,
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
      JSON.stringify({
        providers: [FAKE_INSTANCE],
        providerTypes: { fake: { protocol: FAKE_PROTOCOL } },
      }),
      'utf8',
    )
    const service = new AiModelMainService(makeConfigLocation(dir), {
      _serviceBrand: undefined,
      createLogger: () => spyLogger,
      setLevel: (level: LogLevel) => spyLogger.setLevel(level),
      getLevel: () => spyLogger.level,
    })
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeStreamingProvider([model('fake/default/m')], (source, result) => {
        const err = new CancellationError()
        source.reject(err)
        result.error(err)
      }).provider,
    )
    const ended = collectEnd(service)

    await service.startRequest('r2c', userMsg, { modelId: 'fake/default/m' })
    await ended

    const entriesForRequest = entries.filter((e) => e.message.includes('r2c'))
    expect(entriesForRequest).toHaveLength(1)
    expect(entriesForRequest[0]!.level).toBe(LogLevel.Info)
    expect(entriesForRequest[0]!.message).toContain('canceled')
    service.dispose()
  })

  it('cancelRequest cancels the token the provider received', async () => {
    const service = makeService([FAKE_INSTANCE])
    const handle = fakeStreamingProvider([model('fake/default/m')], (source, result) => {
      void source
      void result
    })
    addProvider(service, FAKE_PROTOCOL, handle.provider)
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
    const service = makeService([{ type: 'nope', name: 'default' }])
    const ended = collectEnd(service)
    await expect(
      service.startRequest('r4', userMsg, { modelId: 'nope/default/x' }),
    ).resolves.toBeUndefined()
    const end = await ended
    expect(end.error?.$isError).toBe(true)
    expect(end.error?.code).toBe(AiErrorCode.ProviderUnavailable)
    expect(end.error?.message).toContain("AI provider type 'nope' is not available")
    service.dispose()
  })

  it('reports provider synchronous failures through the end event instead of rejecting startRequest', async () => {
    const service = makeService([FAKE_INSTANCE])
    addProvider(service, FAKE_PROTOCOL, {
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

  it('merges config: instance settings fill in, per-request options win', async () => {
    const service = makeService([
      { type: 'fake', name: 'default', settings: { 'fake/default/m': { maxTokens: 100 } } },
    ])
    const handle = fakeStreamingProvider([model('fake/default/m')], (source, result) => {
      source.resolve()
      result.complete({})
    })
    addProvider(service, FAKE_PROTOCOL, handle.provider)

    const ended = collectEnd(service)
    await service.startRequest('r5', userMsg, { modelId: 'fake/default/m', temperature: 0.9 })
    await ended

    const opts = handle.lastOptions()
    expect(opts?.temperature).toBe(0.9) // per-request passes through
    expect(opts?.modelConfiguration?.maxTokens).toBe(100) // instance setting fills in
    service.dispose()
  })

  it('exposes an empty model configuration when no settings are stored', async () => {
    const service = makeService([FAKE_INSTANCE])
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeStreamingProvider([model('fake/default/m')], () => undefined).provider,
    )

    const config = await service.getModelConfiguration('fake/default/m')
    expect(config).toEqual({})
    service.dispose()
  })

  it('round-trips per-model configuration through aiSettings.json', async () => {
    const service = makeService([FAKE_INSTANCE])
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeStreamingProvider([model('fake/default/m')], () => undefined).provider,
    )

    await service.setModelConfiguration('fake/default/m', { maxTokens: 256 })
    const config = await service.getModelConfiguration('fake/default/m')
    expect(config.maxTokens).toBe(256)

    const providers = await service.getProviders()
    const instance = providers.find((p) => p.type === 'fake' && p.name === 'default')
    expect(instance?.settings?.['fake/default/m']).toEqual({ maxTokens: 256 })
    service.dispose()
  })

  it('replaces persisted providers via updateProviders', async () => {
    const service = makeService([FAKE_INSTANCE])
    await service.updateProviders([
      { type: 'openai', name: 'custom', baseUrl: 'http://localhost:1234/v1' },
    ])
    const providers = await service.getProviders()
    expect(providers).toEqual([
      { type: 'openai', name: 'custom', baseUrl: 'http://localhost:1234/v1' },
    ])
    service.dispose()
  })

  it('stores, reports, and clears an API key on the instance (auto-creating it)', async () => {
    const service = makeService([{ type: 'openai', name: 'default' }])

    expect(await service.hasApiKey('openai', 'default')).toBe(false)

    await service.setApiKey('openai', 'default', 'sk-123')
    expect(await service.hasApiKey('openai', 'default')).toBe(true)

    // Auto-creates a missing instance, mirroring setModelConfiguration.
    await service.setApiKey('openai', 'second', 'sk-456')
    const providers = await service.getProviders()
    expect(providers.find((p) => p.name === 'second')?.apiKey).toBe('sk-456')

    await service.deleteApiKey('openai', 'default')
    expect(await service.hasApiKey('openai', 'default')).toBe(false)

    service.dispose()
  })

  it('fires onDidChangeModels when a key changes', async () => {
    const service = makeService([{ type: 'openai', name: 'default' }])
    let fired = 0
    service.onDidChangeModels(() => fired++)

    await service.setApiKey('openai', 'default', 'sk-123')
    expect(fired).toBeGreaterThan(0)

    service.dispose()
  })

  it('parses providers and activeModels from a top-level object', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ type: 'openai', name: 'default' }],
        activeModels: { chat: 'openai/default/gpt-4o', inlineCompletion: 'ollama/default/qc' },
      }),
    )
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')
    expect(await service.getActiveModel('inlineCompletion')).toBe('ollama/default/qc')
    service.dispose()
  })

  it('parses and persists the commit and sessionTitle slots round-trip', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ type: 'openai', name: 'default' }],
        activeModels: { commit: 'openai/default/gpt-4o', sessionTitle: 'ollama/default/qc' },
      }),
    )
    expect(await service.getActiveModel('commit')).toBe('openai/default/gpt-4o')
    expect(await service.getActiveModel('sessionTitle')).toBe('ollama/default/qc')

    await service.setActiveModel('sessionTitle', 'openai/default/gpt-4o-mini')
    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.commit).toBe('openai/default/gpt-4o')
    expect(onDisk.activeModels.sessionTitle).toBe('openai/default/gpt-4o-mini')
    service.dispose()
  })

  it('yields no providers when the file is a bare array (no longer supported)', async () => {
    const { service } = makeServiceFromFile(JSON.stringify([{ type: 'openai', name: 'default' }]))
    const providers = await service.getProviders()
    // A top-level array is rejected → no providers (defaults are never synthesized).
    expect(providers).toEqual([])
    expect(await service.getActiveModel('chat')).toBeUndefined()
    service.dispose()
  })

  it('persists setActiveModel into aiSettings.json and fires the change event', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ providers: [{ type: 'openai', name: 'default' }] }),
    )
    const events: string[] = []
    service.onDidChangeActiveModel((e) => events.push(e.kind))

    await service.setActiveModel('chat', 'openai/default/gpt-4o')
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')
    expect(events).toEqual(['chat'])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/default/gpt-4o')
    // Providers are preserved alongside the active selection.
    expect(onDisk.providers).toEqual([{ type: 'openai', name: 'default' }])
    service.dispose()
  })

  it('clears an active-model slot by deleting the key', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ type: 'openai', name: 'default' }],
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

  it('updateProviders preserves the active-model selections', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ type: 'openai', name: 'default' }],
        activeModels: { chat: 'openai/default/gpt-4o' },
      }),
    )
    await service.updateProviders([{ type: 'ollama', name: 'default' }])
    expect(await service.getActiveModel('chat')).toBe('openai/default/gpt-4o')

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/default/gpt-4o')
    expect(onDisk.providers).toEqual([{ type: 'ollama', name: 'default' }])
    service.dispose()
  })

  it('preserves agent authentication state when writing model settings', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [{ type: 'openai', name: 'default' }],
        agentSettings: {
          claude: {
            authentication: {
              profiles: [
                { id: 'claude-work', label: 'Work', kind: 'apiKey', apiKey: 'sk-ant-work' },
              ],
              draft: { kind: 'apiKey', label: 'Unfinished', apiKey: 'sk-ant-draft' },
            },
          },
          codex: {
            authentication: {
              profiles: [{ id: 'codex-work', label: 'Work', kind: 'gateway', apiKey: 'sk-work' }],
            },
          },
        },
      }),
    )

    await service.setActiveModel('chat', 'openai/default/gpt-4o')

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.agentSettings.claude.authentication.profiles[0].apiKey).toBe('sk-ant-work')
    expect(onDisk.agentSettings.claude.authentication.draft.label).toBe('Unfinished')
    expect(onDisk.agentSettings.codex.authentication.profiles[0].apiKey).toBe('sk-work')
    service.dispose()
  })

  it('cancels a metadata request whose provider never responds (no leak on a hung endpoint)', async () => {
    // Regression: getModels has no per-call deadline, so a provider whose fetch
    // never settles leaves its abort store + cancellation listener pending until
    // the process exits (reported as a main-process Disposable leak). The
    // _withTimeoutToken deadline must cancel the token so the provider unwinds.
    const service = makeService([FAKE_INSTANCE])
    const tokenStarted = new DeferredPromise<CancellationToken>()
    addProvider(service, FAKE_PROTOCOL, {
      // Hangs until cancelled, then resolves empty — mirrors a provider that
      // aborts its fetch on token cancellation and falls back to no models.
      provideModels: (_resolved, token: CancellationToken) =>
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

  it('migrates legacy groups[] into providers[] and drops the groups key', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ groups: [{ vendor: 'openai', name: 'default' }] }),
    )
    expect(await service.getProviders()).toEqual([{ name: 'default', type: 'openai' }])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.groups).toBeUndefined()
    expect(onDisk.providers).toEqual([{ name: 'default', type: 'openai' }])
    service.dispose()
  })

  it('migrates a non-builtin legacy vendor into a synthesized type + instance', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        groups: [
          {
            vendor: 'kuro',
            name: 'default',
            baseUrl: 'https://kuro.example/v1',
            models: [{ id: 'qwen3-coder' }],
          },
        ],
      }),
    )
    const types = await service.getProviderTypes()
    expect(types['kuro']).toMatchObject({
      protocol: 'openai-chat',
      defaultBaseUrl: 'https://kuro.example/v1',
      requiresApiKey: true,
      models: [{ id: 'qwen3-coder' }],
    })
    expect(await service.getProviders()).toEqual([{ name: 'default', type: 'kuro' }])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.groups).toBeUndefined()
    expect(onDisk.providerTypes.kuro).toBeDefined()
    service.dispose()
  })

  it('migrates secret-storage keys into instance apiKey and removes them from state.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({ providers: [{ name: 'default', type: 'openai' }] }),
      'utf8',
    )
    const storage = makeStorage({
      secrets: {
        'ai.secret.openai.default.apiKey': Buffer.from('enc:sk-123', 'utf8').toString('base64'),
      },
    })
    const safe = {
      isEncryptionAvailable: () => true,
      decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
    }
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      undefined,
      undefined,
      storage,
      safe,
    )

    const providers = await service.getProviders()
    expect(providers.find((p) => p.name === 'default')?.apiKey).toBe('sk-123')

    const secrets = await storage.get<Record<string, string>>('secrets')
    expect(secrets?.['ai.secret.openai.default.apiKey']).toBeUndefined()
    service.dispose()
  })

  it('keeps secrets in storage when the migration file write fails (retry on next start)', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({ providers: [{ name: 'default', type: 'openai' }] }),
      'utf8',
    )
    // Read-only dir makes the atomic write's tmp-file creation fail with EACCES,
    // standing in for a disk-full / permission failure on the write path.
    chmodSync(dir, 0o500)
    const storage = makeStorage({
      secrets: {
        'ai.secret.openai.default.apiKey': Buffer.from('enc:sk-123', 'utf8').toString('base64'),
      },
    })
    const safe = {
      isEncryptionAvailable: () => true,
      decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
    }
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      undefined,
      undefined,
      storage,
      safe,
    )

    try {
      await expect(service.getProviders()).rejects.toThrow()
    } finally {
      chmodSync(dir, 0o700)
      service.dispose()
    }

    const secrets = await storage.get<Record<string, string>>('secrets')
    expect(secrets?.['ai.secret.openai.default.apiKey']).toBeDefined()
  })

  it('skips secret migration without throwing when OS encryption is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({ providers: [{ name: 'default', type: 'openai' }] }),
      'utf8',
    )
    const storage = makeStorage({ secrets: { 'ai.secret.openai.default.apiKey': 'b64' } })
    const safe = {
      isEncryptionAvailable: () => false,
      decryptString: () => {
        throw new Error('should not be called')
      },
    }
    const service = new AiModelMainService(
      makeConfigLocation(dir),
      undefined,
      undefined,
      storage,
      safe,
    )

    const providers = await service.getProviders()
    expect(providers.find((p) => p.name === 'default')?.apiKey).toBeUndefined()

    const secrets = await storage.get<Record<string, string>>('secrets')
    expect(secrets?.['ai.secret.openai.default.apiKey']).toBe('b64')
    service.dispose()
  })

  it('migrates gateway credential profiles into provider instances + providerRef', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({
        providers: [],
        agentSettings: {
          claude: {
            authentication: {
              profiles: [
                {
                  id: 'c1',
                  label: 'Work Gateway',
                  kind: 'gateway',
                  authToken: 'sk-ant-gw',
                  baseUrl: 'https://claude-gw.example',
                  model: 'claude-sonnet',
                },
              ],
            },
          },
          codex: {
            authentication: {
              profiles: [
                {
                  id: 'x1',
                  label: 'Codex Gateway',
                  kind: 'gateway',
                  apiKey: 'sk-codex-gw',
                  baseUrl: 'https://codex-gw.example',
                },
              ],
            },
          },
        },
      }),
    )

    expect(await service.getProviders()).toEqual([
      {
        name: 'work-gateway',
        type: 'anthropic',
        baseUrl: 'https://claude-gw.example',
        apiKey: 'sk-ant-gw',
      },
      {
        name: 'codex-gateway',
        type: 'openai',
        baseUrl: 'https://codex-gw.example',
        apiKey: 'sk-codex-gw',
      },
    ])

    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.agentSettings.claude.authentication.profiles[0]).toEqual({
      id: 'c1',
      label: 'Work Gateway',
      kind: 'gateway',
      providerRef: 'anthropic/work-gateway',
      model: 'claude-sonnet',
    })
    expect(onDisk.agentSettings.codex.authentication.profiles[0]).toEqual({
      id: 'x1',
      label: 'Codex Gateway',
      kind: 'gateway',
      providerRef: 'openai/codex-gateway',
    })
    service.dispose()
  })

  it('writes aiSettings.json with 0600 permissions', async () => {
    if (process.platform === 'win32') return
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ providers: [{ name: 'default', type: 'openai' }] }),
    )
    await service.setActiveModel('chat', 'openai/default/x')
    const mode = statSync(join(dir, 'aiSettings.json')).mode & 0o777
    expect(mode).toBe(0o600)
    service.dispose()
  })

  it('agent-state writes keep aiSettings.json at 0600', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    writeFileSync(join(dir, 'aiSettings.json'), JSON.stringify({ providers: [] }), 'utf8')
    await updateAiSettingsAgentState(makeConfigLocation(dir), 'claude', () => ({
      authentication: { profiles: [] },
    }))
    const mode = statSync(join(dir, 'aiSettings.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('serializes concurrent model and agent writes without losing either update', async () => {
    const { service, dir } = makeServiceFromFile(
      JSON.stringify({ providers: [{ name: 'default', type: 'openai' }] }),
    )
    await Promise.all([
      service.setActiveModel('chat', 'openai/default/x'),
      updateAiSettingsAgentState(makeConfigLocation(dir), 'claude', () => ({
        authentication: { profiles: [{ id: 'c1', kind: 'apiKey', apiKey: 'sk-ant' }] },
      })),
    ])
    const onDisk = JSON.parse(readFileSync(join(dir, 'aiSettings.json'), 'utf8'))
    expect(onDisk.activeModels.chat).toBe('openai/default/x')
    expect(onDisk.agentSettings.claude.authentication.profiles).toEqual([
      { id: 'c1', kind: 'apiKey', apiKey: 'sk-ant' },
    ])
    service.dispose()
  })

  it('lists built-in and user-defined provider type descriptors', async () => {
    const { service } = makeServiceFromFile(
      JSON.stringify({
        providers: [],
        providerTypes: { kuro: { protocol: 'openai-chat', requiresApiKey: true } },
      }),
    )
    const descriptors = await service.getProviderTypeDescriptors()
    const byId = new Map(descriptors.map((d) => [d.id, d]))
    expect(byId.get('anthropic')?.builtin).toBe(true)
    expect(byId.get('openai')?.builtin).toBe(true)
    expect(byId.get('ollama')?.builtin).toBe(true)
    expect(byId.get('kuro')?.builtin).toBe(false)
    expect(byId.get('kuro')?.protocol).toBe('openai-chat')
    service.dispose()
  })

  it('verifyProvider returns ok:false for an unregistered protocol', async () => {
    const service = makeService([FAKE_INSTANCE])
    const result = await service.verifyProvider({
      type: 'x',
      name: 'y',
      protocol: 'no-such-protocol' as AiWireProtocol,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no-such-protocol')
    service.dispose()
  })

  it('overlays gateway rates on getModels metadata', async () => {
    const service = makeService([FAKE_INSTANCE])
    addProvider(
      service,
      FAKE_PROTOCOL,
      fakeStreamingProvider([model('fake/default/m')], () => undefined).provider,
    )
    const cache = (service as unknown as { _remoteCache: AiRemoteCache })._remoteCache
    cache.setRates('fake/default', { m: { input: 1, output: 2 } })

    const models = await service.getModels()
    const m = models.find((x) => x.id === 'fake/default/m')
    expect(m?.pricingOrigin).toBe('gateway')
    expect(m?.pricing).toEqual({ input: 1, output: 2 })
    service.dispose()
  })

  it('does not rewrite an already-migrated file', async () => {
    const body = JSON.stringify({
      providers: [{ name: 'default', type: 'openai' }],
      activeModels: { chat: 'openai/default/x' },
    })
    const { service, dir } = makeServiceFromFile(body)
    const before = readFileSync(join(dir, 'aiSettings.json'), 'utf8')
    await service.getProviders()
    const after = readFileSync(join(dir, 'aiSettings.json'), 'utf8')
    expect(after).toBe(before)
    service.dispose()
  })

  it('never leaks a provider apiKey into AI debug records or logs', async () => {
    // Regression guard for the key-policy red line: the apiKey lives on the
    // provider instance (AiResolvedProvider.apiKey), never in AiRequestOptions.
    // If someone later adds a key-carrying field to AiRequestOptions, makes the
    // recorder touch AiResolvedProvider, or lets a provider write the key back
    // into options/messages, this must go red.
    const SENTINEL = 'sk-SENTINEL-MUST-NEVER-BE-RECORDED-9f3a'
    const dir = mkdtempSync(join(tmpdir(), 'ai-settings-test-'))
    const sessionDir = mkdtempSync(join(tmpdir(), 'ai-debug-session-'))
    writeFileSync(
      join(dir, 'aiSettings.json'),
      JSON.stringify({
        providers: [{ type: 'fake', name: 'default', apiKey: SENTINEL }],
        providerTypes: { fake: { protocol: FAKE_PROTOCOL } },
      }),
      'utf8',
    )

    // Capture the recorder's human-readable "AI Debug" channel too — the second
    // of its three write paths (JSONL / logger / in-memory ring).
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
    const service = new AiModelMainService(makeConfigLocation(dir), logService, recorder)

    // A fake provider that proves the key truly reached it, then streams a reply.
    let seenApiKey: string | undefined
    const provider: IAiModelProvider = {
      provideModels: () => Promise.resolve([model('fake/default/m')]),
      sendRequest: (_messages, _options, resolved, _token): AiResponse => {
        seenApiKey = resolved.apiKey
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
    await service.startRequest('secret-guard', userMsg, { modelId: 'fake/default/m' })
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
