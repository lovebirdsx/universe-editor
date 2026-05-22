/*---------------------------------------------------------------------------------------------
 *  Stage 7 tests for AcpSessionService — covers ConfigOption ingestion, legacy
 *  `modes` synthesis, and the setConfigOption write path (modern + legacy
 *  fallback). The fake AcpClient here is a slimmed-down version of the one in
 *  AcpSessionService.test.ts, parameterized so each test can supply a custom
 *  `session/new` result and seed `setConfigOption` / `set_mode` acks.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
  StorageScope,
} from '@universe-editor/platform'
import type {
  IConfigurationService,
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IProgressOptions,
  IProgressService,
  IProgressStep,
  IStorageService,
  ITelemetryService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import { CancellationToken } from '@universe-editor/platform'
import { AcpSessionService } from '../acpSessionService.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { IAcpClientService, type IAcpClientNotificationSink } from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'
import {
  AcpConnection,
  AcpRpcError,
  createInMemoryAcpHost,
  type IAcpConnectionHandler,
  type IAcpTransportTestHarness,
} from '../acpConnection.js'
import {
  AcpMethods,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpSessionUpdateParams,
} from '../acpProtocol.js'

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake Agent', command: '/x', args: [] }]
  }
  get(agentId: string) {
    if (agentId === 'fake') return this.list()[0]!
    throw new Error(`unknown agent ${agentId}`)
  }
  resolve(agentId: string) {
    return { command: this.get(agentId).command, args: this.get(agentId).args }
  }
  defaultAgentId(): string {
    return 'fake'
  }
  async health(): Promise<{ available: boolean }> {
    return { available: true }
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly current: IWorkspace | null = null
  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly recent: readonly never[] = []
  private readonly _onDidChangeRecent = new Emitter<readonly never[]>()
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue<
    readonly INotification[]
  >('stub.notifications', [])
  readonly unreadCount: IObservable<number> = observableValue<number>('stub.unread', 0)
  readonly centerVisible: IObservable<boolean> = observableValue<boolean>('stub.center', false)
  notify(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  prompt(): Promise<void> {
    return Promise.resolve()
  }
  status(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  dismiss(): void {}
  cancelProgress(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

class StubProgressService implements IProgressService {
  declare readonly _serviceBrand: undefined
  async withProgress<R>(
    _options: IProgressOptions,
    task: (
      progress: { report(value: IProgressStep): void },
      token: CancellationToken,
    ) => Promise<R>,
  ): Promise<R> {
    return task({ report() {} }, CancellationToken.None)
  }
}

class StubPermissionHandler implements IAcpPermissionHandler {
  declare readonly _serviceBrand: undefined
  tryAutoApprove(_params: AcpRequestPermissionParams): AcpRequestPermissionResult | undefined {
    return undefined
  }
  persistAllow(): void {}
}

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly harness: IAcpTransportTestHarness
}

interface FakeAcpClientOptions {
  /** Extra fields to merge into the `session/new` result. */
  newSessionResult?: {
    modes?: AcpSessionModeState
    configOptions?: readonly AcpSessionConfigOption[]
  }
  /** Result handed back for `session/set_config_option`. */
  setConfigOptionResult?: { configOptions: readonly AcpSessionConfigOption[] }
  /** Error code/message to return for `session/set_config_option`. */
  setConfigOptionError?: { code: number; message: string }
  /** Result for `session/set_mode`. Defaults to empty object. */
  setSessionModeResult?: Record<string, unknown>
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  /** Per-method counts of outbound requests across all sessions. */
  readonly callCounts: Record<string, number> = {}
  /** Capture every outbound JSON-RPC request body for assertions. */
  readonly outbound: { method: string; params: unknown }[] = []
  private _agentSeq = 0

  constructor(private readonly _opts: FakeAcpClientOptions = {}) {}

  async connect(_agentId: string, sink: IAcpClientNotificationSink): Promise<AcpConnection> {
    const agentSessionId = `agent-${++this._agentSeq}`
    const harness = createInMemoryAcpHost()
    const handler: IAcpConnectionHandler = {
      onRequest: () => Promise.reject(new AcpRpcError('not implemented', -32601)),
      onNotification: (_m, p) => sink.onSessionUpdate(p as AcpSessionUpdateParams),
    }
    const conn = new AcpConnection(harness.host, harness.handle, handler, new NullLogger())

    const ack = (rawLines: readonly string[]): void => {
      for (const line of rawLines) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as {
          id?: unknown
          method?: string
          params?: unknown
        }
        if (typeof msg.method === 'string') {
          this.callCounts[msg.method] = (this.callCounts[msg.method] ?? 0) + 1
          if (msg.id !== undefined) {
            this.outbound.push({ method: msg.method, params: msg.params })
          }
        }
        if (typeof msg.id !== 'number' && typeof msg.id !== 'string') continue
        if (msg.method === AcpMethods.Initialize) {
          this._respond(harness, msg.id, { protocolVersion: 1 })
        } else if (msg.method === AcpMethods.NewSession) {
          this._respond(harness, msg.id, {
            sessionId: agentSessionId,
            ...(this._opts.newSessionResult ?? {}),
          })
        } else if (msg.method === AcpMethods.SetConfigOption) {
          if (this._opts.setConfigOptionError) {
            this._respondError(harness, msg.id, this._opts.setConfigOptionError)
          } else {
            this._respond(harness, msg.id, this._opts.setConfigOptionResult ?? {})
          }
        } else if (msg.method === AcpMethods.SetSessionMode) {
          this._respond(harness, msg.id, this._opts.setSessionModeResult ?? {})
        }
      }
    }

    let lastSeen = 0
    const interval: NodeJS.Timeout = setInterval(() => {
      const writes = harness.written()
      if (writes.length > lastSeen) {
        const newLines = writes.slice(lastSeen)
        lastSeen = writes.length
        for (const w of newLines) ack(w.split('\n'))
      }
    }, 1)

    this.connected.push({ sink, harness })
    conn.onExit(() => clearInterval(interval))
    return conn
  }

  private _respond(harness: IAcpTransportTestHarness, id: number | string, result: unknown): void {
    harness.inject(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  private _respondError(
    harness: IAcpTransportTestHarness,
    id: number | string,
    err: { code: number; message: string },
  ): void {
    harness.inject(JSON.stringify({ jsonrpc: '2.0', id, error: err }) + '\n')
  }
}

function buildService(opts: FakeAcpClientOptions = {}): {
  svc: AcpSessionService
  client: FakeAcpClientService
} {
  const client = new FakeAcpClientService(opts)
  const config: IConfigurationService = new ConfigurationService()
  const telemetry: ITelemetryService = new NoopTelemetryService()
  const svc = new AcpSessionService(
    client,
    new FakeAgentRegistry(),
    new FakeWorkspaceService(),
    config,
    new StubNotificationService(),
    telemetry,
    new StubPermissionHandler(),
    new StubProgressService(),
    new StubLoggerService(),
    new AcpSessionHistoryService(new FakeStorage(), telemetry, new StubLoggerService()),
  )
  return { svc, client }
}

describe('AcpSessionService — Stage 7 init', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('seeds configOptions from session/new', async () => {
    const fixture: AcpSessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    }
    const built = buildService({ newSessionResult: { configOptions: [fixture] } })
    svc = built.svc
    const s = await svc.createSession()
    const opts = s.configOptions.get()
    expect(opts).toHaveLength(1)
    expect(opts[0]).toEqual(fixture)
  })

  it('synthesizes a mode ConfigOption from legacy modes', async () => {
    const modes: AcpSessionModeState = {
      currentModeId: 'plan',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'act', name: 'Act' },
      ],
    }
    const built = buildService({ newSessionResult: { modes } })
    svc = built.svc
    const s = await svc.createSession()
    const opts = s.configOptions.get()
    expect(opts).toHaveLength(1)
    expect(opts[0]?.category).toBe('mode')
    expect(opts[0]?.currentValue).toBe('plan')
    expect(opts[0]?.options.map((o) => o.value)).toEqual(['plan', 'act'])
    // The synthetic id is stable so the upstream code can detect "legacy mode".
    expect(opts[0]?.id).toBe('__legacy_mode__')
  })

  it('prefers server-supplied configOptions over legacy modes when both are present', async () => {
    const built = buildService({
      newSessionResult: {
        modes: {
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'edit',
            options: [
              { value: 'edit', name: 'Edit' },
              { value: 'chat', name: 'Chat' },
            ],
          },
        ],
      },
    })
    svc = built.svc
    const s = await svc.createSession()
    const opts = s.configOptions.get()
    // Only the server's mode option appears — the synthetic one is suppressed.
    expect(opts).toHaveLength(1)
    expect(opts[0]?.id).toBe('mode')
    expect(opts[0]?.currentValue).toBe('edit')
  })
})

describe('AcpSessionService — Stage 7 session/update fan-out', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  beforeEach(() => {
    const built = buildService()
    svc = built.svc
    client = built.client
  })

  afterEach(() => {
    svc.dispose()
  })

  it('applies available_commands_update', async () => {
    const s = await svc.createSession()
    client.connected[0]!.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: '/help', description: 'show help' },
          { name: '/diff', description: 'show diff', input: { hint: 'path' } },
        ],
      },
    })
    const cmds = s.availableCommands.get()
    expect(cmds).toHaveLength(2)
    expect(cmds[1]).toEqual({
      name: '/diff',
      description: 'show diff',
      input: { hint: 'path' },
    })
  })

  it('applies config_option_update verbatim and replaces prior values', async () => {
    const s = await svc.createSession()
    client.connected[0]!.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    })
    const opts = s.configOptions.get()
    expect(opts).toHaveLength(1)
    expect(opts[0]?.currentValue).toBe('high')
    // A subsequent push replaces the array.
    client.connected[0]!.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'low',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    })
    expect(s.configOptions.get()[0]?.currentValue).toBe('low')
  })

  it('applies current_mode_update to the synthetic mode option', async () => {
    const modes: AcpSessionModeState = {
      currentModeId: 'plan',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'act', name: 'Act' },
      ],
    }
    svc.dispose()
    const built = buildService({ newSessionResult: { modes } })
    svc = built.svc
    client = built.client
    const s = await svc.createSession()
    expect(s.configOptions.get()[0]?.currentValue).toBe('plan')
    client.connected[0]!.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'act' },
    })
    expect(s.configOptions.get()[0]?.currentValue).toBe('act')
  })
})

describe('AcpSessionService — Stage 7 setConfigOption write path', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  afterEach(() => {
    svc?.dispose()
  })

  it('sends session/set_config_option and applies the returned configOptions', async () => {
    const initial: AcpSessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    }
    const updated: AcpSessionConfigOption = { ...initial, currentValue: 'opus' }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionResult: { configOptions: [updated] },
    })
    svc = built.svc
    client = built.client
    const s = await svc.createSession()
    await s.setConfigOption('model', 'opus')
    expect(client.callCounts[AcpMethods.SetConfigOption]).toBe(1)
    expect(client.callCounts[AcpMethods.SetSessionMode] ?? 0).toBe(0)
    expect(s.configOptions.get()[0]?.currentValue).toBe('opus')
    const sent = client.outbound.find((m) => m.method === AcpMethods.SetConfigOption)
    expect(sent?.params).toMatchObject({
      sessionId: 'agent-1',
      configId: 'model',
      value: 'opus',
    })
  })

  it('falls back to session/set_mode for legacy-mode-only agents', async () => {
    const modes: AcpSessionModeState = {
      currentModeId: 'plan',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'act', name: 'Act' },
      ],
    }
    const built = buildService({ newSessionResult: { modes } })
    svc = built.svc
    client = built.client
    const s = await svc.createSession()
    // The synthetic option's id is __legacy_mode__; the service must detect
    // that and route through session/set_mode, not session/set_config_option.
    const opt = s.configOptions.get()[0]!
    await s.setConfigOption(opt.id, 'act')
    expect(client.callCounts[AcpMethods.SetSessionMode]).toBe(1)
    expect(client.callCounts[AcpMethods.SetConfigOption] ?? 0).toBe(0)
    expect(s.configOptions.get()[0]?.currentValue).toBe('act')
    const sent = client.outbound.find((m) => m.method === AcpMethods.SetSessionMode)
    expect(sent?.params).toMatchObject({ sessionId: 'agent-1', modeId: 'act' })
  })

  it('uses session/set_config_option when both legacy modes and a server mode option exist', async () => {
    // Server provided a real mode ConfigOption — legacy `modes` is stored only
    // for awareness, but writes must go through the modern endpoint.
    const built = buildService({
      newSessionResult: {
        modes: {
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'edit',
            options: [
              { value: 'edit', name: 'Edit' },
              { value: 'chat', name: 'Chat' },
            ],
          },
        ],
      },
      setConfigOptionResult: { configOptions: [] },
    })
    svc = built.svc
    client = built.client
    const s = await svc.createSession()
    await s.setConfigOption('mode', 'chat')
    expect(client.callCounts[AcpMethods.SetConfigOption]).toBe(1)
    expect(client.callCounts[AcpMethods.SetSessionMode] ?? 0).toBe(0)
  })

  it('propagates errors from session/set_config_option', async () => {
    const initial: AcpSessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionError: { code: -32603, message: 'unsupported value' },
    })
    svc = built.svc
    const s = await svc.createSession()
    await expect(s.setConfigOption('model', 'gpt-5')).rejects.toThrow(/unsupported value/)
    // State should be unchanged.
    expect(s.configOptions.get()[0]?.currentValue).toBe('sonnet')
  })
})
