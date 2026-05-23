/*---------------------------------------------------------------------------------------------
 *  Stage 7 tests for AcpSessionService — covers ConfigOption ingestion, legacy
 *  `modes` synthesis, and the setConfigOption write path (modern + legacy
 *  fallback). The fake ACP client wires an in-memory ACP stream pair to a stub
 *  Agent so each test can parameterize `session/new` response shape and the
 *  setConfigOption / setSessionMode behaviour.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  Emitter,
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
import {
  AgentSideConnection,
  ClientSideConnection,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'
import { createInMemoryAcpPair } from '../testing/inMemoryAcpPair.js'

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
  tryAutoApprove(_params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    return undefined
  }
  persistAllow(): void {}
}

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  constructor() {
    // Mirror production behaviour: MainStorageService fires onDidChangeWorkspaceScope
    // once on startup. Doing it on a microtask lets the history/defaults services
    // subscribe first (via Event.toPromise) and avoids the 500ms cold-start timeout
    // in _scheduleInitialLoad.
    queueMicrotask(() => this._onDidChangeWorkspaceScope.fire())
  }
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

// ---------------------------------------------------------------------------
// Parameterized stub agent + fake AcpClient
// ---------------------------------------------------------------------------

interface FakeAcpClientOptions {
  /** Extra fields to merge into the `session/new` result. */
  newSessionResult?: {
    modes?: SessionModeState
    configOptions?: readonly SessionConfigOption[]
  }
  /** Result handed back for `session/set_config_option`. Defaults to `{ configOptions: [] }`. */
  setConfigOptionResult?: { configOptions: readonly SessionConfigOption[] }
  /** Error code/message to throw from `session/set_config_option`. */
  setConfigOptionError?: { code: number; message: string }
  /** Result for `session/set_mode`. Defaults to an empty object. */
  setSessionModeResult?: Record<string, unknown>
  /**
   * Optional promise the agent will await BEFORE returning from
   * `session/set_config_option` — used by the in-flight suppression test to
   * keep the call pending while we inject a rogue `config_option_update`.
   */
  setConfigOptionGate?: () => Promise<void>
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly newSessionCalls: NewSessionRequest[] = []
  readonly loadSessionCalls: LoadSessionRequest[] = []
  readonly promptCalls: PromptRequest[] = []
  readonly cancelCalls: CancelNotification[] = []
  readonly setSessionModeCalls: SetSessionModeRequest[] = []
  readonly setConfigOptionCalls: SetSessionConfigOptionRequest[] = []

  constructor(
    private readonly _agentSessionId: string,
    private readonly _opts: FakeAcpClientOptions,
  ) {}

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params)
    return Promise.resolve({
      sessionId: this._agentSessionId,
      ...(this._opts.newSessionResult ?? {}),
    } as unknown as NewSessionResponse)
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(params)
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(params)
    return new Promise<never>(() => {})
  }

  cancel(params: CancelNotification): Promise<void> {
    this.cancelCalls.push(params)
    return Promise.resolve()
  }

  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    this.setSessionModeCalls.push(params)
    return Promise.resolve((this._opts.setSessionModeResult ?? {}) as SetSessionModeResponse)
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.setConfigOptionCalls.push(params)
    const tail = (): SetSessionConfigOptionResponse => {
      if (this._opts.setConfigOptionError) {
        throw new RequestError(
          this._opts.setConfigOptionError.code,
          this._opts.setConfigOptionError.message,
        )
      }
      return (this._opts.setConfigOptionResult ?? {
        configOptions: [],
      }) as SetSessionConfigOptionResponse
    }
    const gate = this._opts.setConfigOptionGate
    if (gate) {
      return gate().then(tail)
    }
    return Promise.resolve(tail())
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly agent: StubAgent
  readonly agentConn: AgentSideConnection
  readonly clientConn: ClientSideConnection
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  private _agentSeq = 0

  constructor(private readonly _opts: FakeAcpClientOptions = {}) {}

  async connect(_agentId: string, sink: IAcpClientNotificationSink): Promise<IAcpClientConnection> {
    const agentSessionId = `agent-${++this._agentSeq}`
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(agentSessionId, this._opts)
    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const clientImpl: Client = {
      requestPermission: (params) => sink.onRequestPermission(params),
      sessionUpdate: async (params) => {
        sink.onSessionUpdate(params)
      },
    }
    const clientConn = new ClientSideConnection(() => clientImpl, pair.clientStream)
    this.connected.push({ sink, agent, agentConn, clientConn })
    return {
      conn: clientConn,
      dispose: (): void => {
        void pair.clientStream.writable.close().catch(() => {})
        void pair.agentStream.writable.close().catch(() => {})
      },
    }
  }
}

function buildService(opts: FakeAcpClientOptions = {}): {
  svc: AcpSessionService
  client: FakeAcpClientService
  history: AcpSessionHistoryService
  agentDefaults: AcpAgentDefaultsService
} {
  const client = new FakeAcpClientService(opts)
  const config: IConfigurationService = new ConfigurationService()
  const telemetry: ITelemetryService = new NoopTelemetryService()
  const history = new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    telemetry,
    new StubLoggerService(),
  )
  const agentDefaults = new AcpAgentDefaultsService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    telemetry,
    new StubLoggerService(),
  )
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
    history,
    new FakeStorage(),
    agentDefaults,
  )
  return { svc, client, history, agentDefaults }
}

describe('AcpSessionService — Stage 7 init', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('seeds configOptions from session/new', async () => {
    const fixture: SessionConfigOption = {
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
    const modes: SessionModeState = {
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
    expect(opts[0]?.type).toBe('select')
    const first = opts[0]
    if (first && first.type === 'select') {
      const values = (first.options as readonly { value: string }[]).map((o) => o.value)
      expect(values).toEqual(['plan', 'act'])
    }
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
    const modes: SessionModeState = {
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
    const initial: SessionConfigOption = {
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
    const updated: SessionConfigOption = { ...initial, currentValue: 'opus' }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionResult: { configOptions: [updated] },
    })
    svc = built.svc
    client = built.client
    const s = await svc.createSession()
    await s.setConfigOption('model', 'opus')
    const agent = client.connected[0]!.agent
    expect(agent.setConfigOptionCalls).toHaveLength(1)
    expect(agent.setSessionModeCalls).toHaveLength(0)
    expect(s.configOptions.get()[0]?.currentValue).toBe('opus')
    expect(agent.setConfigOptionCalls[0]).toMatchObject({
      sessionId: 'agent-1',
      configId: 'model',
      value: 'opus',
    })
  })

  it('falls back to session/set_mode for legacy-mode-only agents', async () => {
    const modes: SessionModeState = {
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
    const agent = client.connected[0]!.agent
    expect(agent.setSessionModeCalls).toHaveLength(1)
    expect(agent.setConfigOptionCalls).toHaveLength(0)
    expect(s.configOptions.get()[0]?.currentValue).toBe('act')
    expect(agent.setSessionModeCalls[0]).toMatchObject({
      sessionId: 'agent-1',
      modeId: 'act',
    })
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
    const agent = client.connected[0]!.agent
    expect(agent.setConfigOptionCalls).toHaveLength(1)
    expect(agent.setSessionModeCalls).toHaveLength(0)
  })

  it('propagates errors from session/set_config_option', async () => {
    const initial: SessionConfigOption = {
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

describe('AcpSessionService — setConfigOption persistence side-effects', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('writes both per-session history and per-agent default on a successful modern call', async () => {
    const initial: SessionConfigOption = {
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
    const updated: SessionConfigOption = { ...initial, currentValue: 'opus' }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionResult: { configOptions: [updated] },
    })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()
    const s = await svc.createSession()
    await s.setConfigOption('model', 'opus')
    const entry = built.history.list().find((e) => e.id === s.historyId)
    expect(entry?.configOptions).toEqual({ model: 'opus' })
    expect(built.agentDefaults.getDefaults('fake')).toEqual({ model: 'opus' })
  })

  it('does NOT persist when the legacy mode path is taken (synthetic id has no cross-agent meaning)', async () => {
    const modes: SessionModeState = {
      currentModeId: 'plan',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'act', name: 'Act' },
      ],
    }
    const built = buildService({ newSessionResult: { modes } })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()
    const s = await svc.createSession()
    const legacyOpt = s.configOptions.get()[0]!
    expect(legacyOpt.category).toBe('mode')
    await s.setConfigOption(legacyOpt.id, 'act')
    // setSessionMode must have been called and persistence must NOT have happened.
    const agent = built.client.connected[0]!.agent
    expect(agent.setSessionModeCalls).toHaveLength(1)
    const entry = built.history.list().find((e) => e.id === s.historyId)
    expect(entry?.configOptions).toBeUndefined()
    expect(built.agentDefaults.getDefaults('fake')).toEqual({})
  })

  it('suppresses an in-flight `config_option_update` echo for the same configId (user wins)', async () => {
    const initial: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
        { value: 'haiku', name: 'Haiku' },
      ],
    }
    const acked: SessionConfigOption = { ...initial, currentValue: 'opus' }
    let release!: () => void
    const gateP = new Promise<void>((r) => {
      release = r
    })
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionResult: { configOptions: [acked] },
      setConfigOptionGate: () => gateP,
    })
    svc = built.svc
    await built.history.initialize()
    const s = await svc.createSession()
    const sink = built.client.connected[0]!.sink
    // Start a write but DON'T await — _pendingPushes now has 'model'.
    const writeP = s.setConfigOption('model', 'opus')
    // Inject a rogue echo for the same configId. Must be filtered.
    sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ ...initial, currentValue: 'haiku' }],
      },
    })
    // Still pending — should NOT have flipped to 'haiku'.
    expect(s.configOptions.get()[0]?.currentValue).toBe('sonnet')
    release()
    await writeP
    // Agent's response wins; rogue echo was suppressed.
    expect(s.configOptions.get()[0]?.currentValue).toBe('opus')
  })

  it('lets `config_option_update` for OTHER ids through merged into current state while one is in-flight', async () => {
    // When the update contains both the in-flight id AND a different id, the
    // filter strips the in-flight id and the remaining ids merge into the
    // existing array (so OTHER ids see the new value, model is preserved).
    const model: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
        { value: 'haiku', name: 'Haiku' },
      ],
    }
    const thoughtFresh: SessionConfigOption = {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    }
    let release!: () => void
    const gateP = new Promise<void>((r) => {
      release = r
    })
    const built = buildService({
      newSessionResult: { configOptions: [model] },
      setConfigOptionResult: { configOptions: [{ ...model, currentValue: 'opus' }] },
      setConfigOptionGate: () => gateP,
    })
    svc = built.svc
    await built.history.initialize()
    const s = await svc.createSession()
    const sink = built.client.connected[0]!.sink
    const writeP = s.setConfigOption('model', 'opus')
    // Update contains BOTH the in-flight model (filtered) and thought_level (merged).
    sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ ...model, currentValue: 'haiku' }, thoughtFresh],
      },
    })
    const mid = s.configOptions.get()
    // model preserved at 'sonnet' (rogue echo filtered).
    expect(mid.find((o) => o.id === 'model')?.currentValue).toBe('sonnet')
    // thought_level was merged into the existing array.
    expect(mid.find((o) => o.id === 'thought_level')?.currentValue).toBe('high')
    release()
    await writeP
  })

  it('clears the in-flight gate even when the agent throws', async () => {
    const initial: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionError: { code: -32603, message: 'boom' },
    })
    svc = built.svc
    await built.history.initialize()
    const s = await svc.createSession()
    await expect(s.setConfigOption('model', 'opus')).rejects.toThrow(/boom/)
    // A subsequent legitimate update for the same id must NOT be filtered.
    built.client.connected[0]!.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ ...initial, currentValue: 'sonnet' }],
      },
    })
    // The update went through (still 'sonnet', but the array reference was
    // replaced — the assertion here is that `_pendingPushes` is empty so the
    // filter no longer rejects 'model').
    expect(s.configOptions.get()[0]?.currentValue).toBe('sonnet')
  })
})

describe('AcpSessionService — createSession push-back of agent defaults', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('pushes back saved agent defaults to a freshly minted session', async () => {
    const initial: SessionConfigOption = {
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
    const acked: SessionConfigOption = { ...initial, currentValue: 'opus' }
    const built = buildService({
      newSessionResult: { configOptions: [initial] },
      setConfigOptionResult: { configOptions: [acked] },
    })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()
    // Seed a default BEFORE creating the session.
    built.agentDefaults.setDefault('fake', 'model', 'opus')
    const s = await svc.createSession()
    // Push-back is scheduled via queueMicrotask. Yield a couple cycles.
    await new Promise((r) => setTimeout(r, 20))
    const agent = built.client.connected[0]!.agent
    expect(agent.setConfigOptionCalls).toHaveLength(1)
    expect(agent.setConfigOptionCalls[0]).toMatchObject({ configId: 'model', value: 'opus' })
    expect(s.configOptions.get()[0]?.currentValue).toBe('opus')
  })

  it('skips push-back when the agent default already matches the server currentValue', async () => {
    const initial: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    }
    const built = buildService({ newSessionResult: { configOptions: [initial] } })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()
    built.agentDefaults.setDefault('fake', 'model', 'sonnet')
    await svc.createSession()
    await new Promise((r) => setTimeout(r, 20))
    const agent = built.client.connected[0]!.agent
    expect(agent.setConfigOptionCalls).toHaveLength(0)
  })

  it('skips push-back for configIds the agent did not advertise', async () => {
    const built = buildService({ newSessionResult: { configOptions: [] } })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()
    built.agentDefaults.setDefault('fake', 'mystery', 'value')
    await svc.createSession()
    await new Promise((r) => setTimeout(r, 20))
    expect(built.client.connected[0]!.agent.setConfigOptionCalls).toHaveLength(0)
  })
})
