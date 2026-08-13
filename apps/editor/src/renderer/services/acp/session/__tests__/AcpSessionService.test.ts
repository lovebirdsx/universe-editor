/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionService.ts
 *  Drives AcpSessionService with a fake AcpClientService backed by an
 *  in-memory ACP stream pair + a stub Agent implementation. We dispatch
 *  session/update notifications via the sink the service registers on
 *  connect() to exercise the streaming / tool-call / plan code paths
 *  without going through the SDK wire.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  autorun,
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  Event,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
  StorageScope,
  UriIdentityService,
} from '@universe-editor/platform'
import type {
  IConfigurationService,
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IStorageService,
  ITelemetryService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type ContentBlock,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpCapabilities,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import {
  AcpSession,
  PLAN_AUTO_EXECUTE_DELAY_MS,
  REWIND_SESSION_METHOD,
  SIDE_TASK_ROLE_PROMPT,
} from '../acpSession.js'
import type { AcpPendingElicitation, AcpPendingPermission } from '../acpSessionModel.js'
import { ACP_CAPABILITIES_META_KEY } from '../acpExtMethods.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { AcpAuthGuidanceService } from '../acpAuthGuidanceService.js'
import { AcpSessionFactory } from '../acpSessionFactory.js'
import { AcpPromptDraftCache } from '../acpPromptDraftCache.js'
import { AcpPromptCancelledDraftStash } from '../acpPromptCancelledDraftStash.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubExtensionMcpServersService } from './stubExtensionMcpServers.js'
import { StubMcpServerEnablementService } from './stubMcpServerEnablement.js'
import { StubFileService } from './stubFileService.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import type { IAcpSessionTitleService } from '../acpSessionTitleService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../../acpClientService.js'
import type { IAcpAgentRegistry } from '../../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../../acpPermissionHandler.js'
import { createInMemoryAcpPair } from '../../testing/inMemoryAcpPair.js'
import { stubWindowsService } from './stubWindowsService.js'

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [
      { id: 'fake', name: 'Fake Agent', command: '/x', args: [] },
      { id: 'claude-code', name: 'Claude Code', command: '/claude', args: [] },
      { id: 'codex', name: 'Codex', command: '/codex', args: [] },
    ]
  }
  allAgentIds(): readonly string[] {
    // Empty on purpose — these tests exercise createSession/resumeSession in
    // isolation; the protocol-hydrate sweep that consumes allAgentIds() runs
    // through its own dedicated tests with a real ACP pair.
    return []
  }
  get(agentId: string) {
    const found = this.list().find((a) => a.id === agentId)
    if (found) return found
    throw new Error(`unknown agent ${agentId}`)
  }
  resolve(agentId: string) {
    return { command: this.get(agentId).command, args: this.get(agentId).args }
  }
  defaultAgentId(): string {
    return 'fake'
  }
  readonly defaultAgentIdObs = observableValue<string>('fake.defaultAgentId', 'fake')
  setDefaultAgentId(_agentId: string): void {}
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
  readonly whenReady: Promise<void> = Promise.resolve()
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue<
    readonly INotification[]
  >('stub.notifications', [])
  readonly unreadCount: IObservable<number> = observableValue<number>('stub.unread', 0)
  readonly centerVisible: IObservable<boolean> = observableValue<boolean>('stub.center', false)
  readonly captured: { message: string; severity: unknown }[] = []
  notify(opts: { severity: unknown; message: string }): INotificationHandle {
    this.captured.push({ message: opts.message, severity: opts.severity })
    return { close: () => {} } as unknown as INotificationHandle
  }
  prompt(): Promise<void> {
    return Promise.resolve()
  }
  status(): INotificationHandle {
    return { close: () => {} } as unknown as INotificationHandle
  }
  dismiss(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
  cancelProgress(): void {}
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

class StubPermissionHandler implements IAcpPermissionHandler {
  declare readonly _serviceBrand: undefined
  autoApproveResult: RequestPermissionResponse | undefined = undefined
  readonly persisted: string[] = []
  tryAutoApprove(_params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    return this.autoApproveResult
  }
  persistAllow(kind: string): void {
    this.persisted.push(kind)
  }
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

/** Extract the text of every `text` block, in order. */
function textBlocksOf(blocks: readonly ContentBlock[]): string[] {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
}

function makeHistory(): AcpSessionHistoryService {
  return new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_URI_IDENTITY,
  )
}

function makeCompactionStats(): AcpCompactionStatsService {
  return new AcpCompactionStatsService(
    new FakeStorage(),
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
}

function makeAgentDefaults(): AcpAgentDefaultsService {
  return new AcpAgentDefaultsService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
}

// ---------------------------------------------------------------------------
// Stub Agent — replays a configurable script of responses to the four
// AcpSessionService outbound methods (initialize, newSession, prompt, cancel).
// Tests can also override individual handlers per-instance.
// ---------------------------------------------------------------------------

interface StubAgentOptions {
  /** When true, prompt() never resolves — used to exercise cancelTurn. */
  promptHangs?: boolean
  /**
   * When true, each prompt() returns a deferred whose resolve/reject is pushed
   * to `promptDeferreds` — lets tests orchestrate the settle order of several
   * concurrent (steering) prompts.
   */
  promptControl?: boolean
  /** When true, initialize() never resolves — used to exercise startup timeout. */
  initializeHangs?: boolean
  /** Advertised MCP transports; omitted means the agent supports none (stdio only). */
  mcpCapabilities?: McpCapabilities
  /** When true, advertise loadSession so resumeSession can proceed. */
  loadSession?: boolean
  /** When true, loadSession() never resolves — used to inject updates mid-replay. */
  loadSessionHangs?: boolean
  /** configOptions the agent returns from newSession (and loadSession). */
  newSessionConfigOptions?: readonly SessionConfigOption[]
  /** Fixed PromptResponse to return (e.g. to echo a specific userMessageId). */
  promptResponse?: PromptResponse
  /** When true, advertise sessionCapabilities.fork so forkSession can proceed. */
  forkCapable?: boolean
  /**
   * When true, advertise the universe rewind capability via initialize `_meta`
   * so rewindSession is unlocked. `filesRolledBackByAgent` controls whether the
   * agent rolls files back itself (Claude) or leaves it to the client (Codex).
   */
  rewindCapable?: boolean
  filesRolledBackByAgent?: boolean
  /** sessionId returned from unstable_forkSession (the new forked session id). */
  forkedSessionId?: string
  /** Result returned from extMethod(REWIND_SESSION_METHOD). */
  rewindResult?: Record<string, unknown>
  /** Extra delay before initialize() resolves — exercises slow-handshake paths. */
  initializeDelayMs?: number
  /** Extra delay before newSession() resolves — exercises slow session/new. */
  newSessionDelayMs?: number
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly newSessionCalls: NewSessionRequest[] = []
  readonly loadSessionCalls: LoadSessionRequest[] = []
  readonly promptCalls: PromptRequest[] = []
  readonly cancelCalls: CancelNotification[] = []
  readonly setConfigOptionCalls: SetSessionConfigOptionRequest[] = []
  readonly extMethodCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly forkCalls: ForkSessionRequest[] = []
  /** Deferred controls for promptControl mode, one per in-flight prompt(). */
  readonly promptDeferreds: Array<{
    resolve: () => void
    reject: (err: Error) => void
  }> = []

  constructor(
    private readonly _agentSessionId: string,
    private readonly _opts: StubAgentOptions = {},
  ) {}

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    if (this._opts.initializeHangs) return new Promise<never>(() => {})
    const response = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: (this._opts.loadSession ?? false) || (this._opts.loadSessionHangs ?? false),
        promptCapabilities: {},
        ...(this._opts.forkCapable ? { sessionCapabilities: { fork: {} } } : {}),
        ...(this._opts.mcpCapabilities ? { mcpCapabilities: this._opts.mcpCapabilities } : {}),
        ...(this._opts.rewindCapable
          ? {
              _meta: {
                [ACP_CAPABILITIES_META_KEY]: {
                  rewind: {
                    filesRolledBackByAgent: this._opts.filesRolledBackByAgent ?? true,
                  },
                },
              },
            }
          : {}),
      },
      authMethods: [],
    } as unknown as InitializeResponse
    const delay = this._opts.initializeDelayMs
    if (delay !== undefined) {
      return new Promise((resolve) => setTimeout(() => resolve(response), delay))
    }
    return Promise.resolve(response)
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params)
    const response = {
      sessionId: this._agentSessionId,
      ...(this._opts.newSessionConfigOptions
        ? { configOptions: this._opts.newSessionConfigOptions }
        : {}),
    } as unknown as NewSessionResponse
    const delay = this._opts.newSessionDelayMs
    if (delay !== undefined) {
      return new Promise((resolve) => setTimeout(() => resolve(response), delay))
    }
    return Promise.resolve(response)
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(params)
    if (this._opts.promptHangs) return new Promise<never>(() => {})
    if (this._opts.promptControl) {
      return new Promise<PromptResponse>((resolve, reject) => {
        this.promptDeferreds.push({
          resolve: () => resolve({ stopReason: 'end_turn' } as unknown as PromptResponse),
          reject,
        })
      })
    }
    return Promise.resolve(
      this._opts.promptResponse ?? ({ stopReason: 'end_turn' } as unknown as PromptResponse),
    )
  }

  cancel(params: CancelNotification): Promise<void> {
    this.cancelCalls.push(params)
    return Promise.resolve()
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.setConfigOptionCalls.push(params)
    return Promise.resolve({} as unknown as SetSessionConfigOptionResponse)
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(params)
    if (this._opts.loadSessionHangs) return new Promise<never>(() => {})
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }

  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.extMethodCalls.push({ method, params })
    if (method === REWIND_SESSION_METHOD) {
      return Promise.resolve(this._opts.rewindResult ?? { canRewind: true })
    }
    return Promise.resolve({})
  }

  unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.forkCalls.push(params)
    return Promise.resolve({
      sessionId: this._opts.forkedSessionId ?? `${this._agentSessionId}-fork`,
    } as unknown as ForkSessionResponse)
  }
}

/**
 * Captures the sink + connection so tests can inject inbound traffic.
 */
interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly agent: StubAgent
  readonly agentConn: AgentSideConnection
  readonly clientConn: ClientSideConnection
  /** Set to true once the returned IAcpClientConnection.dispose() runs. */
  disposed: boolean
}

interface FakeAcpClientOptions {
  readonly stubOptions?: StubAgentOptions
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  /** One ConnectedSession per connect() call, in order. */
  readonly connected: ConnectedSession[] = []
  private _agentSeq = 0
  private _sink: IAcpClientNotificationSink | undefined

  constructor(private readonly _opts: FakeAcpClientOptions = {}) {}

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  drainAll(): void {
    // best-effort close of in-flight streams in tests
  }

  killConnectionFor(): void {}

  async connect(_agentId: string): Promise<IAcpClientConnection> {
    const sink = this._sink
    if (!sink) throw new Error('FakeAcpClientService.connect: sink not installed')
    const agentSessionId = `agent-${++this._agentSeq}`
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(agentSessionId, this._opts.stubOptions ?? {})
    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const clientImpl: Client = {
      requestPermission: (params) => sink.onRequestPermission(params),
      sessionUpdate: async (params) => {
        sink.onSessionUpdate(params)
      },
      extNotification: async (method, params) => {
        sink.onExtNotification?.(method, params)
      },
    }
    const clientConn = new ClientSideConnection(() => clientImpl, pair.clientStream)

    const initializeResult = clientConn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    initializeResult.catch(() => {})

    const session: ConnectedSession = { sink, agent, agentConn, clientConn, disposed: false }
    this.connected.push(session)
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {
        session.disposed = true
        // Close both writers to signal end-of-stream — SDK then aborts the
        // ClientSideConnection's signal and resolves `closed`. We swallow
        // double-close errors so dispose() stays idempotent.
        void pair.clientStream.writable.close().catch(() => {})
        void pair.agentStream.writable.close().catch(() => {})
      },
    }
  }
}

describe('AcpSessionService', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService
  let notifications: StubNotificationService
  let permission: StubPermissionHandler
  let config: IConfigurationService
  let history: AcpSessionHistoryService
  beforeEach(() => {
    client = new FakeAcpClientService()
    notifications = new StubNotificationService()
    permission = new StubPermissionHandler()
    config = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    const changeTracker = new StubSessionChangeTracker()
    const titleService = new StubSessionTitleService()
    const compactionStats = makeCompactionStats()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        changeTracker,
        titleService,
        compactionStats,
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
  })

  afterEach(() => {
    svc.dispose()
  })

  it('createSession spawns a connection and appends to sessions / sets active', async () => {
    const session = await svc.createSession()
    await session.whenConnected()
    expect(session.agentId).toBe('fake')
    expect(svc.sessions.get()).toHaveLength(1)
    expect(svc.activeSession.get()?.id).toBe(session.id)
    expect(svc.activeSessionId.get()).toBe(session.id)
  })

  it('createSession passes options.cwd to session/new instead of the workspace folder', async () => {
    const session = await svc.createSession(undefined, { cwd: '/tmp/deep-link-cwd' })
    await session.whenConnected()
    expect(client.connected[0]!.agent.newSessionCalls[0]!.cwd).toBe('/tmp/deep-link-cwd')
  })

  it('registers createSession sessions so they dispose with the service (no leak)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    expect(conn.disposed).toBe(false)
    svc.dispose()
    // Disposing the service must cascade to the session's connection. Without
    // `this._register(session)` in createSession the session is orphaned and
    // its DisposableStore leaks (reported by DisposableTracker on teardown).
    expect(conn.disposed).toBe(true)
  })

  it('records a complete create profile for the handshake', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const profiles = svc.getSessionCreateProfiles()
    expect(profiles).toHaveLength(1)
    const profile = profiles[0]!
    expect(profile.agentId).toBe('fake')
    expect(profile.failed).toBeUndefined()
    expect(profile.endedAt).toBeDefined()
    // The fake client service does not emit the client-layer steps
    // (willResolveBinary / willSpawn / willInitialize) — those belong to the
    // real AcpClientService. The service-layer sequence must be complete.
    expect(profile.steps.map((s) => s.name)).toEqual([
      'willResolveMcp',
      'didResolveMcp',
      'willConnect',
      'didConnect',
      'willNewSession',
      'didNewSession',
      'didHistoryAdd',
      'didAttach',
    ])
    const ats = profile.steps.map((s) => s.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)
  })

  it('captures a slow session/new in the create profile', async () => {
    const slowClient = new FakeAcpClientService({ stubOptions: { newSessionDelayMs: 30 } })
    const slowSvc = new AcpSessionService(
      slowClient,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      new NoopTelemetryService(),
      permission,
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        new NoopTelemetryService(),
        makeHistory(),
        makeAgentDefaults(),
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await slowSvc.createSession()
    await s.whenConnected()
    const profile = slowSvc.getSessionCreateProfiles()[0]!
    const at = (name: string) => profile.steps.find((st) => st.name === name)!.at
    expect(at('didNewSession') - at('willNewSession')).toBeGreaterThanOrEqual(25)
    slowSvc.dispose()
  })

  it('setActive switches the active session', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    await a.whenConnected()
    await b.whenConnected()
    expect(svc.activeSession.get()?.id).toBe(b.id)
    svc.setActive(a.id)
    expect(svc.activeSession.get()?.id).toBe(a.id)
    expect(svc.activeSessionId.get()).toBe(a.id)
  })

  it('routes session/update notifications to the matching session by agentSessionId', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    await a.whenConnected()
    await b.whenConnected()
    const connA = client.connected[0]!
    const connB = client.connected[1]!

    connA.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello A' },
      },
    })
    connB.sink.onSessionUpdate({
      sessionId: 'agent-2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello B' },
      },
    })

    const aMsgs = a.messages.get()
    const bMsgs = b.messages.get()
    expect(aMsgs.map((m) => m.text)).toEqual(['hello A'])
    expect(bMsgs.map((m) => m.text)).toEqual(['hello B'])
  })

  it('streams chunks into a single message while the turn is open and flushes on completion', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'foo' },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'bar' },
      },
    })
    const msgsMid = s.messages.get()
    expect(msgsMid).toHaveLength(1)
    expect(msgsMid[0]?.text).toBe('foobar')
    expect(msgsMid[0]?.role).toBe('agent')
  })

  it('stamps a client-generated messageId on the user message and sends it as _meta.messageId', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    await s.sendPrompt('anchor me')

    const user = s.messages.get().find((m) => m.role === 'user')
    expect(user?.messageId).toBeTruthy()
    expect(conn.agent.promptCalls).toHaveLength(1)
    // The id sent on the wire matches the one stamped on the local message.
    expect(conn.agent.promptCalls[0]?._meta?.messageId).toBe(user?.messageId)
  })

  it('adopts the agent-echoed userMessageId when it differs from the sent id', async () => {
    // Build a service whose stub echoes a different userMessageId on the response.
    svc.dispose()
    client = new FakeAcpClientService({
      stubOptions: {
        promptResponse: { stopReason: 'end_turn', _meta: { userMessageId: 'agent-uuid-xyz' } },
      },
    })
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      notifications,
      new NoopTelemetryService(),
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        new NoopTelemetryService(),
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    await s.whenConnected()

    await s.sendPrompt('reconcile me')

    const user = s.messages.get().find((m) => m.role === 'user')
    expect(user?.messageId).toBe('agent-uuid-xyz')
  })

  it('batches observer notifications across a burst of chunks (16ms throttle)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    let observerFires = 0
    const sub = autorun((r) => {
      s.messages.read(r)
      observerFires++
    })
    try {
      expect(observerFires).toBe(1)
      for (let i = 0; i < 10; i++) {
        conn.sink.onSessionUpdate({
          sessionId: 'agent-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `c${i}` },
          },
        })
      }
      expect(
        s.messages
          .get()
          .map((m) => m.text)
          .join(''),
      ).toBe('c0c1c2c3c4c5c6c7c8c9')
      expect(observerFires).toBe(1)

      await new Promise((r) => setTimeout(r, 24))
      expect(observerFires).toBe(2)
    } finally {
      sub.dispose()
    }
  })

  it('tracks tool calls and updates them in place', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
      },
    })
    let calls = s.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe('in_progress')

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'output' } }],
      },
    })
    calls = s.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe('completed')
    expect(calls[0]?.text).toBe('output')
    expect(calls[0]?.title).toBe('Read file')
  })

  it('tool_call_update overrides title and kind when the agent reveals them later', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-exec',
        title: '',
        status: 'pending',
      },
    })
    let calls = s.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.title).toBe('')
    expect(calls[0]?.kind).toBe('unknown')

    const revealedTitle = 'execute cd /tmp && pnpm typecheck'
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-exec',
        title: revealedTitle,
        kind: 'execute',
        status: 'in_progress',
      },
    })
    calls = s.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.title).toBe(revealedTitle)
    expect(calls[0]?.kind).toBe('execute')
    expect(calls[0]?.status).toBe('in_progress')
  })

  it('publishes plan entries verbatim', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'step one', priority: 'high', status: 'pending' },
          { content: 'step two', priority: 'medium', status: 'pending' },
        ],
      },
    })
    const plan = s.plan.get()
    expect(plan).toEqual([
      { content: 'step one', priority: 'high', status: 'pending' },
      { content: 'step two', priority: 'medium', status: 'pending' },
    ])
  })

  it('preserves per-entry status across plan snapshots', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'a', priority: 'medium', status: 'completed' },
          { content: 'b', priority: 'medium', status: 'in_progress' },
          { content: 'c', priority: 'medium', status: 'pending' },
        ],
      },
    })
    expect(s.plan.get().map((e) => e.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('mirrors the plan snapshot onto the history entry', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'step one', priority: 'high', status: 'in_progress' }],
      },
    })
    expect(history.get('agent-1')?.plan).toEqual([
      { content: 'step one', priority: 'high', status: 'in_progress' },
    ])
  })

  it('an empty plan snapshot clears the history mirror', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
      },
    })
    expect(history.get('agent-1')?.plan).toBeDefined()
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'plan', entries: [] },
    })
    expect(history.get('agent-1')?.plan).toBeUndefined()
  })

  it('closeSession removes the session and falls back to the next active one', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    await svc.closeSession(b.id)
    expect(svc.sessions.get().map((x) => x.id)).toEqual([a.id])
    expect(svc.activeSessionId.get()).toBe(a.id)
    await svc.closeSession(a.id)
    expect(svc.activeSessionId.get()).toBeUndefined()
  })

  it('cancelTurn sends a session/cancel notification to the agent', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    await s.cancelTurn()
    // Cancel arrives async over the SDK stream; flush microtasks.
    await new Promise((r) => setTimeout(r, 10))
    expect(conn.agent.cancelCalls).toHaveLength(1)
    expect(conn.agent.cancelCalls[0]?.sessionId).toBe('agent-1')
  })

  it('getById returns undefined for unknown ids', async () => {
    expect(svc.getById('nope')).toBeUndefined()
    const a = await svc.createSession()
    await a.whenConnected()
    expect(svc.getById(a.id)?.id).toBe(a.id)
  })

  it('cancelTurn aborts the pending session/prompt locally even if agent never responds', async () => {
    // For this test we need a hanging prompt(). Build a service whose fake
    // client wires a stub agent in promptHangs mode.
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('hi there')
    // Give the prompt request time to land on the agent side.
    await new Promise((r) => setTimeout(r, 10))
    expect(conn.agent.promptCalls).toHaveLength(1)
    expect(s.status.get()).toBe('running')

    let cancelRestoreFires = 0
    const sub = s.onDidCancelForRestore(() => cancelRestoreFires++)
    await s.cancelTurn()
    await promptPromise
    expect(s.status.get()).toBe('idle')
    // No '[cancelled]' sentinel — the cancel surfaces via onDidCancelForRestore
    // so the input box can restore the submitted draft instead.
    expect(s.messages.get().some((m) => m.text === '[cancelled]')).toBe(false)
    expect(cancelRestoreFires).toBe(1)
    // The just-sent user message is retracted too — the restored draft replaces
    // it, so the timeline keeps no trace of the cancelled turn.
    expect(s.messages.get().some((m) => m.role === 'user')).toBe(false)
    expect(s.timeline.get().filter((it) => it.kind === 'message')).toHaveLength(0)
    sub.dispose()
  })

  it('cancelTurn persists the retracted message id to history so a later resume filters the replay', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('hi there')
    await new Promise((r) => setTimeout(r, 10))
    const sentMessageId = s.messages.get().find((m) => m.role === 'user')?.messageId
    expect(sentMessageId).toBeDefined()

    await s.cancelTurn()
    await promptPromise

    // The persisted id is the same anchor the wire prompt carried — the
    // transcript's user row has this uuid, so resume replay can match on it.
    expect(conn.agent.promptCalls[0]?._meta?.['messageId']).toBe(sentMessageId)
    expect(history.get('agent-1')?.retractedMessageIds).toEqual([sentMessageId])
  })

  it('cancelTurn after partial agent output is a normal interruption — the turn stays, nothing is restored or persisted', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('hi there')
    await new Promise((r) => setTimeout(r, 10))
    // The agent starts answering — a single streamed character is enough to
    // turn a later cancel into a normal interruption.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'p' },
      },
    })

    let cancelRestoreFires = 0
    const sub = s.onDidCancelForRestore(() => cancelRestoreFires++)
    await s.cancelTurn()
    await promptPromise
    expect(s.status.get()).toBe('idle')

    // The user message and the partial answer both stay on the timeline, and
    // the interruption marker is appended locally — the live stream never
    // delivers the SDK's marker row, but a later resume replays it from the
    // transcript, so live appends the same trace to keep the two identical.
    const texts = s.messages.get().map((m) => `${m.role}:${m.text}`)
    expect(texts).toEqual(['user:hi there', 'agent:p', 'user:[Request interrupted by user]'])
    // No draft restore, no persisted retraction.
    expect(cancelRestoreFires).toBe(0)
    expect(history.get('agent-1')?.retractedMessageIds).toBeUndefined()
    sub.dispose()
  })

  it('cancelTurn with restorePrompt:false does not fire onDidCancelForRestore (rewind path)', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      permission,
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    await s.whenConnected()

    const promptPromise = s.sendPrompt('hi there')
    await new Promise((r) => setTimeout(r, 10))
    let cancelRestoreFires = 0
    const sub = s.onDidCancelForRestore(() => cancelRestoreFires++)
    await s.cancelTurn({ restorePrompt: false })
    await promptPromise
    expect(s.status.get()).toBe('idle')
    expect(cancelRestoreFires).toBe(0)
    // No restore → the sent user message stays on the timeline.
    expect(s.messages.get().some((m) => m.role === 'user' && m.text === 'hi there')).toBe(true)
    sub.dispose()
  })

  it('cancelTurn with no in-flight prompt does not fire onDidCancelForRestore', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    let cancelRestoreFires = 0
    const sub = s.onDidCancelForRestore(() => cancelRestoreFires++)
    await s.cancelTurn()
    expect(cancelRestoreFires).toBe(0)
    sub.dispose()
  })

  describe('concurrent steering prompts', () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

    function rebuildControlled(): void {
      svc.dispose()
      client = new FakeAcpClientService({ stubOptions: { promptControl: true } })
      const history = makeHistory()
      const agentDefaults = makeAgentDefaults()
      svc = new AcpSessionService(
        client,
        new FakeAgentRegistry(),
        new FakeWorkspaceService(),
        new ConfigurationService(),
        notifications,
        new NoopTelemetryService(),
        permission,
        new StubLoggerService(),
        history,
        new FakeStorage(),
        agentDefaults,
        new StubConfigOptionsCache(),
        FAKE_URI_IDENTITY,
        new AcpAuthGuidanceService(notifications, {
          executeCommand: async () => undefined,
        } as never),
        new AcpSessionFactory(
          new NoopTelemetryService(),
          history,
          agentDefaults,
          new StubSessionChangeTracker(),
          new StubSessionTitleService(),
          makeCompactionStats(),
        ),
        new StubFileService(),
        new StubExtensionMcpServersService(),
        new StubMcpServerEnablementService(),
        stubWindowsService(),
      )
    }

    it('stays running until the last of several concurrent prompts settles', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!
      const p1 = s.sendPrompt('one')
      const p2 = s.sendPrompt('two')
      await tick()
      expect(conn.agent.promptCalls).toHaveLength(2)
      expect(s.status.get()).toBe('running')

      conn.agent.promptDeferreds[0]!.resolve()
      await tick()
      expect(s.status.get()).toBe('running') // one still in-flight

      conn.agent.promptDeferreds[1]!.resolve()
      await Promise.all([p1, p2])
      expect(s.status.get()).toBe('idle')
    })

    it('lands on errored with a single [error] when one of two prompts fails', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!
      const p1 = s.sendPrompt('one')
      const p2 = s.sendPrompt('two')
      await tick()
      conn.agent.promptDeferreds[0]!.reject(new Error('boom'))
      conn.agent.promptDeferreds[1]!.resolve()
      await Promise.all([p1, p2])
      expect(s.status.get()).toBe('errored')
      const errors = s.messages.get().filter((m) => m.text?.startsWith('[error]'))
      expect(errors).toHaveLength(1)
    })

    it('cancelTurn interrupts all in-flight prompts with a single notification and one restore event', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!
      const p1 = s.sendPrompt('one')
      const p2 = s.sendPrompt('two')
      await tick()
      expect(s.status.get()).toBe('running')

      let cancelRestoreFires = 0
      const sub = s.onDidCancelForRestore(() => cancelRestoreFires++)
      await s.cancelTurn()
      await Promise.all([p1, p2])
      expect(conn.agent.cancelCalls).toHaveLength(1)
      expect(s.messages.get().some((m) => m.text === '[cancelled]')).toBe(false)
      expect(cancelRestoreFires).toBe(1)
      // Only the latest dispatched prompt's user message is retracted (matching
      // the last-wins restore stash); the earlier one stays.
      expect(
        s.messages
          .get()
          .filter((m) => m.role === 'user')
          .map((m) => m.text),
      ).toEqual(['one'])
      expect(s.status.get()).toBe('idle')
      sub.dispose()
    })

    it('keeps the stashed submitted draft after a cancel; clears it after a clean settle', async () => {
      rebuildControlled()
      AcpPromptCancelledDraftStash._resetForTests()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!

      // PromptInput stashes on submit; simulate that here.
      AcpPromptCancelledDraftStash.save(s.id, { text: 'one' })
      const p1 = s.sendPrompt('one')
      await tick()
      await s.cancelTurn()
      await p1
      // Cancel keeps the stash so onDidCancelForRestore can restore it.
      expect(AcpPromptCancelledDraftStash.drain(s.id)).toEqual({ text: 'one' })

      AcpPromptCancelledDraftStash.save(s.id, { text: 'two' })
      const p2 = s.sendPrompt('two')
      await tick()
      conn.agent.promptDeferreds[1]!.resolve()
      await p2
      // A clean settle drops the stash so it can't resurface on a later cancel.
      expect(AcpPromptCancelledDraftStash.drain(s.id)).toBeUndefined()
    })

    it('recovers from errored to running to idle when a new prompt is sent', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!
      const p1 = s.sendPrompt('one')
      await tick()
      conn.agent.promptDeferreds[0]!.reject(new Error('boom'))
      await p1
      expect(s.status.get()).toBe('errored')

      const p2 = s.sendPrompt('two')
      await tick()
      expect(s.status.get()).toBe('running')
      conn.agent.promptDeferreds[1]!.resolve()
      await p2
      expect(s.status.get()).toBe('idle')
    })

    it('shows a steering message on the timeline immediately while a turn runs', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      void s.sendPrompt('first')
      await tick()
      expect(s.status.get()).toBe('running')
      // The steering prompt's user message lands synchronously, before its
      // prompt() ever resolves.
      void s.sendPrompt('steer me')
      const users = s.messages.get().filter((m) => m.role === 'user')
      expect(users.map((m) => m.text)).toEqual(['first', 'steer me'])
    })
  })

  it('auto-approves a permission request when the kind is on the allow list', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    permission.autoApproveResult = { outcome: { outcome: 'selected', optionId: 'opt1' } }
    const result = await svc.onRequestPermission({
      sessionId: 'agent-1',
      toolCall: { toolCallId: 'tc1', kind: 'read' },
      options: [{ optionId: 'opt1', name: 'Allow', kind: 'allow_once' }],
    } as RequestPermissionRequest)
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt1' } })
    expect(s.pendingPermission.get()).toBeUndefined()
  })

  it('routes interactive permission requests to the matching session and resolves via the card', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    await a.whenConnected()
    await b.whenConnected()
    void a // satisfy TS
    const pendingPromise = svc.onRequestPermission({
      sessionId: 'agent-2',
      toolCall: { toolCallId: 'tc2', kind: 'edit', title: 'Edit src/foo.ts' },
      options: [
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    } as RequestPermissionRequest)
    await new Promise((r) => setTimeout(r, 0))
    expect(a.pendingPermission.get()).toBeUndefined()
    const pending = b.pendingPermission.get()
    expect(pending?.title).toBe('Edit src/foo.ts')
    pending!.resolve('always')
    const result = await pendingPromise
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(b.pendingPermission.get()).toBeUndefined()
    expect(permission.persisted).toEqual(['edit'])
  })

  it('returns cancelled when the user denies via the card', async () => {
    const b = await svc.createSession()
    await b.whenConnected()
    const promise = svc.onRequestPermission({
      sessionId: 'agent-1',
      toolCall: { toolCallId: 'tc3' },
      options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    } as RequestPermissionRequest)
    await new Promise((r) => setTimeout(r, 0))
    b.pendingPermission.get()!.cancel()
    await expect(promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('cancels a pending permission card when the session closes', async () => {
    const b = await svc.createSession()
    await b.whenConnected()
    const promise = svc.onRequestPermission({
      sessionId: 'agent-1',
      toolCall: { toolCallId: 'tc4' },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
    } as RequestPermissionRequest)
    await new Promise((r) => setTimeout(r, 0))
    expect(b.pendingPermission.get()).toBeDefined()
    await svc.closeSession(b.id)
    await expect(promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('returns cancelled when the request targets an unknown session', async () => {
    const result = await svc.onRequestPermission({
      sessionId: 'agent-nope',
      toolCall: { toolCallId: 'tc5' },
      options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
    } as RequestPermissionRequest)
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  describe('plan review auto-execute (acp.plan.autoExecute)', () => {
    const planOptions = [
      { optionId: 'bypassPermissions', name: 'Yes, and bypass permissions', kind: 'allow_always' },
      { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ]

    function requestPlanReview(sessionId: string): Promise<RequestPermissionResponse> {
      return svc.onRequestPermission({
        sessionId,
        toolCall: { toolCallId: 'tcp1', title: 'Ready to code?', kind: 'switch_mode' },
        options: planOptions,
      } as RequestPermissionRequest)
    }

    it('attaches autoResolve when the setting names a present option', async () => {
      const s = await svc.createSession()
      await s.whenConnected()
      config.update('acp.plan.autoExecute', 'bypassPermissions', ConfigurationTarget.Memory)
      const promise = requestPlanReview('agent-1')
      await new Promise((r) => setTimeout(r, 0))
      const pending = s.pendingPermission.get()
      expect(pending?.autoResolve).toEqual({
        optionId: 'bypassPermissions',
        delayMs: PLAN_AUTO_EXECUTE_DELAY_MS,
      })
      pending!.cancel()
      await promise
    })

    it('omits autoResolve when the setting is off or unset', async () => {
      const s = await svc.createSession()
      await s.whenConnected()
      const promise = requestPlanReview('agent-1')
      await new Promise((r) => setTimeout(r, 0))
      expect(s.pendingPermission.get()?.autoResolve).toBeUndefined()
      s.pendingPermission.get()!.cancel()
      await promise
    })

    it('omits autoResolve when the configured option is absent from the request options', async () => {
      const s = await svc.createSession()
      await s.whenConnected()
      config.update('acp.plan.autoExecute', 'acceptEdits', ConfigurationTarget.Memory)
      const promise = requestPlanReview('agent-1')
      await new Promise((r) => setTimeout(r, 0))
      expect(s.pendingPermission.get()?.autoResolve).toBeUndefined()
      s.pendingPermission.get()!.cancel()
      await promise
    })

    it('never silently auto-approves switch_mode even when the handler matches', async () => {
      const s = await svc.createSession()
      await s.whenConnected()
      permission.autoApproveResult = {
        outcome: { outcome: 'selected', optionId: 'bypassPermissions' },
      }
      const promise = requestPlanReview('agent-1')
      await new Promise((r) => setTimeout(r, 0))
      expect(s.pendingPermission.get()).toBeDefined()
      s.pendingPermission.get()!.cancel()
      await expect(promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    })

    it('does not persist switch_mode into the autoApprove list when bypass is chosen', async () => {
      const s = await svc.createSession()
      await s.whenConnected()
      const promise = requestPlanReview('agent-1')
      await new Promise((r) => setTimeout(r, 0))
      s.pendingPermission.get()!.resolve('bypassPermissions')
      await expect(promise).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'bypassPermissions' },
      })
      expect(permission.persisted).toEqual([])
    })
  })
})

describe('AcpSessionService — rewind / fork', () => {
  function makeService(client: FakeAcpClientService, tracker: StubSessionChangeTracker) {
    return makeServiceWithHistory(client, tracker).svc
  }

  function makeServiceWithHistory(client: FakeAcpClientService, tracker: StubSessionChangeTracker) {
    const history = makeHistory()
    const notification = new StubNotificationService()
    const agentDefaults = makeAgentDefaults()
    const telemetry = new NoopTelemetryService()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        tracker,
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    return { svc, history }
  }

  it('rewindSession sends the rewind ext-method with the target messageId and clears tracked changes', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, rewindCapable: true },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const conn = client.connected[0]!
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId
      expect(messageId).toBeTruthy()

      const result = await svc.rewindSession(s.id, messageId!)

      expect(result).toEqual({ canRewind: true })
      const rewindCall = conn.agent.extMethodCalls.find((c) => c.method === REWIND_SESSION_METHOD)
      expect(rewindCall?.params).toMatchObject({ sessionId: 'agent-1', messageId })
      // Files were rolled back, so the baseline change tracker must be reset.
      expect(tracker.clearedSessions).toContain('agent-1')
    } finally {
      svc.dispose()
    }
  })

  it('rewindSession dryRun previews without cancelling the turn or clearing changes', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: {
        forkCapable: true,
        rewindCapable: true,
        rewindResult: { canRewind: true, filesChanged: ['a.ts'], insertions: 3, deletions: 1 },
      },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const conn = client.connected[0]!
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      const result = await svc.rewindSession(s.id, messageId!, { dryRun: true })

      expect(result).toMatchObject({ filesChanged: ['a.ts'], insertions: 3, deletions: 1 })
      const rewindCall = conn.agent.extMethodCalls.find((c) => c.method === REWIND_SESSION_METHOD)
      expect(rewindCall?.params).toMatchObject({ dryRun: true })
      // Preview must not mutate local state.
      expect(tracker.clearedSessions).not.toContain('agent-1')
      expect(conn.agent.cancelCalls).toHaveLength(0)
    } finally {
      svc.dispose()
    }
  })

  it('rewindSession with rewindFiles:false truncates the conversation but keeps tracked changes', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, rewindCapable: true },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const conn = client.connected[0]!
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      const result = await svc.rewindSession(s.id, messageId!, { rewindFiles: false })

      expect(result).toEqual({ canRewind: true })
      const rewindCall = conn.agent.extMethodCalls.find((c) => c.method === REWIND_SESSION_METHOD)
      expect(rewindCall?.params).toMatchObject({ rewindFiles: false })
      // Files were kept, so the change tracker must stay intact.
      expect(tracker.clearedSessions).not.toContain('agent-1')
    } finally {
      svc.dispose()
    }
  })

  it('rewindSession is a no-op for a non-claude agent (capability-gated)', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService()
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('fake')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const conn = client.connected[0]!
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      const result = await svc.rewindSession(s.id, messageId!)

      expect(result).toBeUndefined()
      expect(conn.agent.extMethodCalls.some((c) => c.method === REWIND_SESSION_METHOD)).toBe(false)
    } finally {
      svc.dispose()
    }
  })

  it('codex rewindSession rolls files back via the change tracker (not the ext-method)', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { rewindCapable: true, filesRolledBackByAgent: false },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('codex')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const conn = client.connected[0]!
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId
      expect(messageId).toBeTruthy()

      const result = await svc.rewindSession(s.id, messageId!)

      expect(result).toEqual({ canRewind: true })
      // codex truncates history via the ext-method WITHOUT the rewindFiles flag…
      const rewindCall = conn.agent.extMethodCalls.find((c) => c.method === REWIND_SESSION_METHOD)
      expect(rewindCall?.params).toMatchObject({ sessionId: 'agent-1', messageId })
      expect(rewindCall?.params).not.toHaveProperty('rewindFiles')
      // …and rolls files back client-side via the tracker (never clear()).
      expect(tracker.restoredCalls.some((c) => c.sessionId === 'agent-1')).toBe(true)
      expect(tracker.clearedSessions).not.toContain('agent-1')
    } finally {
      svc.dispose()
    }
  })

  it('codex rewindSession with rewindFiles:false keeps files (no tracker restore)', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { rewindCapable: true, filesRolledBackByAgent: false },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('codex')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      await svc.rewindSession(s.id, messageId!, { rewindFiles: false })

      expect(tracker.restoredCalls.some((c) => c.sessionId === 'agent-1')).toBe(false)
    } finally {
      svc.dispose()
    }
  })

  it('forkSession forks at the given message and registers + activates the new session', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-fork-1' },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      const fork = await svc.forkSession(s.id, messageId)

      expect(fork.id).toBe('agent-fork-1')
      // The fork RPC carried the source id + the rewind anchor.
      const forkAgent = client.connected.find((c) => c.agent.forkCalls.length > 0)!
      expect(forkAgent.agent.forkCalls[0]).toMatchObject({ sessionId: 'agent-1' })
      expect(forkAgent.agent.forkCalls[0]?._meta).toMatchObject({ rewindTo: messageId })
      // The new session is registered, distinct from the source, and active.
      expect(svc.getById('agent-fork-1')).toBeDefined()
      expect(svc.activeSession.get()?.id).toBe('agent-fork-1')
      expect(fork.id).not.toBe(s.id)
    } finally {
      svc.dispose()
    }
  })

  it('forkSession carries the source session runtime config onto the fork history row', async () => {
    const tracker = new StubSessionChangeTracker()
    const forkConfig: readonly SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'claude-opus-4-8',
        options: [
          { value: 'claude-fable-5', name: 'Claude Fable 5' },
          { value: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
        ],
      } as unknown as SessionConfigOption,
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      } as unknown as SessionConfigOption,
    ]
    const client = new FakeAcpClientService({
      stubOptions: {
        forkCapable: true,
        loadSession: true,
        forkedSessionId: 'agent-fork-2',
        newSessionConfigOptions: forkConfig,
      },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      const messageId = s.messages.get().find((m) => m.role === 'user')?.messageId

      await svc.forkSession(s.id, messageId)

      // The fork's durable row must inherit the source's model/effort so its
      // resume can push them back to the freshly-forked agent thread.
      const entry = history.get('agent-fork-2')
      expect(entry?.configOptions).toMatchObject({ model: 'claude-opus-4-8', effort: 'high' })
      expect(entry?.configLabels).toMatchObject({ model: 'Claude Opus 4.8', effort: 'High' })
    } finally {
      svc.dispose()
    }
  })

  it('forkSession rejects when the agent does not advertise fork capability', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      await expect(svc.forkSession(s.id)).rejects.toThrow(/fork/)
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask registers a child row with the quote and the read-only mode override', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-1' },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      const side = await svc.forkSideTask(s.id, { text: 'quoted text', label: 'quote summary' })

      expect(side.id).toBe('agent-side-1')
      const entry = history.get('agent-side-1')
      expect(entry?.sideTaskOf).toBe('agent-1')
      expect(entry?.sideTaskQuote).toBe('quoted text')
      expect(entry?.title).toBe('quote summary')
      expect(entry?.configOptions?.['mode']).toBe('dontAsk')
      expect(entry?.configLabels?.['mode']).toBe('dontAsk')
      // Side chats never steal the active session.
      expect(svc.activeSession.get()?.id).toBe(s.id)
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask overrides an explicitly-selected mode with the read-only value', async () => {
    const tracker = new StubSessionChangeTracker()
    const modeConfig: readonly SessionConfigOption[] = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      } as unknown as SessionConfigOption,
    ]
    const client = new FakeAcpClientService({
      stubOptions: {
        forkCapable: true,
        loadSession: true,
        forkedSessionId: 'agent-side-2',
        newSessionConfigOptions: modeConfig,
      },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      await svc.forkSideTask(s.id, { text: 'q', label: 'l' })

      expect(history.get('agent-side-2')?.configOptions?.['mode']).toBe('dontAsk')
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask uses the codex read-only mode value for non-claude agents', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-3' },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('codex')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      await svc.forkSideTask(s.id, { text: 'q', label: 'l' })

      expect(history.get('agent-side-3')?.configOptions?.['mode']).toBe('read-only')
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask suppresses the baseline replay on the child timeline', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: {
        forkCapable: true,
        loadSession: true,
        loadSessionHangs: true,
        forkedSessionId: 'agent-side-4',
      },
    })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      // The child's session/load never settles, so forkSideTask stays pending
      // with the suppression window open — the agent replays the inherited
      // baseline mid-replay, exactly as a real loadSession would stream it.
      void svc.forkSideTask(s.id, { text: 'q', label: 'l' }).catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-4')).toBeDefined()
      })
      const side = svc.getById('agent-side-4')!
      const forkConn = client.connected.find((c) => c.agent.forkCalls.length > 0)!
      forkConn.sink.onSessionUpdate({
        sessionId: 'agent-side-4',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'baseline replay' },
        },
      })

      expect(side.timeline.get()).toEqual([])
    } finally {
      svc.dispose()
    }
  })

  it('resuming a side-task row suppresses the baseline replay (re-open path)', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { loadSession: true, loadSessionHangs: true },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      // Simulate a re-open after restart: the row already carries the side-task
      // flag, and the plain resumeSession path (no fork caller) must suppress
      // the replayed baseline exactly like the fork-time resume does.
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-reopen',
        title: 'side chat',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
      })

      // session/load never settles, so resumeSession stays pending with the
      // suppression window open while the agent streams the baseline.
      void svc.resumeSession('agent-side-reopen').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-reopen')).toBeDefined()
      })
      const side = svc.getById('agent-side-reopen')!
      client.connected[0]!.sink.onSessionUpdate({
        sessionId: 'agent-side-reopen',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'baseline replay' },
        },
      })

      expect(side.timeline.get()).toEqual([])
    } finally {
      svc.dispose()
    }
  })

  it('resuming a side-task row keeps the side task’s own turns after the anchor', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { loadSession: true, loadSessionHangs: true },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      // Re-open after restart: the row carries the side-task flag AND the anchor
      // recorded when the side task sent its first prompt.
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-anchor',
        title: 'side chat',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
        sideTaskAnchorMessageId: 'anchor-msg',
      })

      void svc.resumeSession('agent-side-anchor').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-anchor')).toBeDefined()
      })
      const side = svc.getById('agent-side-anchor')!
      const sink = client.connected[0]!.sink

      // Baseline traffic before the anchor is suppressed…
      sink.onSessionUpdate({
        sessionId: 'agent-side-anchor',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'baseline user' },
          messageId: 'baseline-msg',
        } as never,
      })
      sink.onSessionUpdate({
        sessionId: 'agent-side-anchor',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'baseline agent' },
        },
      })
      expect(side.timeline.get()).toEqual([])

      // …but the anchor message and the side task's own turn after it survive.
      sink.onSessionUpdate({
        sessionId: 'agent-side-anchor',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'side-task first prompt' },
          messageId: 'anchor-msg',
        } as never,
      })
      sink.onSessionUpdate({
        sessionId: 'agent-side-anchor',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'side-task answer' },
        },
      })

      const texts = side.timeline
        .get()
        .filter((it) => it.kind === 'message')
        .map((it) => (it.kind === 'message' ? `${it.message.role}:${it.message.text}` : ''))
      expect(texts).toEqual(['user:side-task first prompt', 'agent:side-task answer'])
    } finally {
      svc.dispose()
    }
  })

  it('strips the hidden role lead from the replayed side-task first message', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { loadSession: true, loadSessionHangs: true },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-lead',
        title: 'side chat',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
        sideTaskAnchorMessageId: 'anchor-msg',
      })

      void svc.resumeSession('agent-side-lead').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-lead')).toBeDefined()
      })
      const side = svc.getById('agent-side-lead')!
      const sink = client.connected[0]!.sink

      // The agent persisted the anchor turn's wire prompt verbatim, so its
      // replay leads with the hidden role instruction as its own chunk…
      sink.onSessionUpdate({
        sessionId: 'agent-side-lead',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: SIDE_TASK_ROLE_PROMPT },
          messageId: 'anchor-msg',
        } as never,
      })
      // …followed by the user's own text under the same messageId.
      sink.onSessionUpdate({
        sessionId: 'agent-side-lead',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'explain this excerpt' },
          messageId: 'anchor-msg',
        } as never,
      })

      const messages = side.messages.get()
      expect(messages).toHaveLength(1)
      expect(messages[0]!.text).toBe('explain this excerpt')

      // Fused shape: an agent that merges the lead into the user's text block
      // gets the prefix stripped instead.
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-fused',
        title: 'side chat 2',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
        sideTaskAnchorMessageId: 'anchor-fused',
      })
      void svc.resumeSession('agent-side-fused').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-fused')).toBeDefined()
      })
      const fusedSink = client.connected[1]!.sink
      fusedSink.onSessionUpdate({
        sessionId: 'agent-side-fused',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: `${SIDE_TASK_ROLE_PROMPT}\n\nwhat does this do` },
          messageId: 'anchor-fused',
        } as never,
      })
      const fusedMessages = svc.getById('agent-side-fused')!.messages.get()
      expect(fusedMessages).toHaveLength(1)
      expect(fusedMessages[0]!.text).toBe('what does this do')
    } finally {
      svc.dispose()
    }
  })

  it('sendPrompt pins the anchor messageId on a side-task row (write-once)', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { loadSession: true, loadSessionHangs: true },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-pin',
        title: 'side chat',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
      })

      void svc.resumeSession('agent-side-pin').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-pin')).toBeDefined()
      })
      const side = svc.getById('agent-side-pin')!

      await side.sendPrompt('first side prompt')
      const afterFirst = history.get('agent-side-pin')
      expect(afterFirst?.sideTaskAnchorMessageId).toBeDefined()
      const anchor = afterFirst!.sideTaskAnchorMessageId!

      // A later prompt must not move the anchor.
      await side.sendPrompt('second side prompt')
      expect(history.get('agent-side-pin')?.sideTaskAnchorMessageId).toBe(anchor)
    } finally {
      svc.dispose()
    }
  })

  it('slips the hidden role prompt into a side task’s first turn only, never into the UI', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { loadSession: true, loadSessionHangs: true },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      history.add({
        agentId: 'claude-code',
        sessionIdOnAgent: 'agent-side-role',
        title: 'side chat',
        sideTaskOf: 'agent-parent',
        sideTaskQuote: 'quoted text',
      })

      void svc.resumeSession('agent-side-role').catch(() => {})
      await vi.waitFor(() => {
        expect(svc.getById('agent-side-role')).toBeDefined()
      })
      const side = svc.getById('agent-side-role')!
      const agent = client.connected[0]!.agent

      await side.sendPrompt('explain this excerpt')
      const first = agent.promptCalls[0]!
      const firstBlock = first.prompt[0]!
      // First wire block is the hidden role instruction (a text block the model
      // reads before the user's own text).
      expect(firstBlock.type).toBe('text')
      if (firstBlock.type !== 'text') throw new Error('expected text block')
      expect(firstBlock.text).toContain('side-chat assistant')
      // The user's own text follows as a later block.
      const texts = textBlocksOf(first.prompt)
      expect(texts[texts.length - 1]).toBe('explain this excerpt')
      // …but the role prompt never lands on the UI timeline.
      const uiTexts = side.messages.get().map((m) => m.text)
      expect(uiTexts.some((t) => t.includes('side-chat assistant'))).toBe(false)
      expect(uiTexts).toContain('explain this excerpt')

      // Second turn: no re-injection.
      await side.sendPrompt('and another question')
      const second = agent.promptCalls[1]!
      const secondTexts = textBlocksOf(second.prompt)
      expect(secondTexts.some((t) => t.includes('side-chat assistant'))).toBe(false)
      expect(secondTexts).toContain('and another question')
    } finally {
      svc.dispose()
    }
  })

  it('does not inject the role prompt into a normal (non-side-task) session', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('hello there')
      const agent = client.connected[0]!.agent
      const first = agent.promptCalls[0]!
      const texts = textBlocksOf(first.prompt)
      expect(texts.some((t) => t.includes('side-chat assistant'))).toBe(false)
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask rejects when the agent does not advertise fork capability', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const svc = makeService(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      await expect(svc.forkSideTask(s.id, { text: 'q', label: 'l' })).rejects.toThrow(/fork/)
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask rejects read-only (foreign) sessions', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true },
    })
    const svc = makeService(client, tracker)
    try {
      await expect(svc.forkSideTask('no-such-session', { text: 'q', label: 'l' })).rejects.toThrow(
        /side task/,
      )
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask derives the child title from the question after the quote prefill', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-5' },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      const side = await svc.forkSideTask(s.id, { text: 'quoted text', label: 'quote summary' })
      // The prefilled prompt leads with the quote block; the derived title must
      // come from the user's own question, not the quote (the stub title
      // service never generates, so the derived title is what lands).
      await side.sendPrompt('> quoted text\n>\n> more quote\n\nexplain this function')
      await new Promise((r) => setTimeout(r, 0))

      expect(history.get('agent-side-5')?.title).toBe('explain this function')
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask keeps the quote-label title when the first prompt is only the quote', async () => {
    const tracker = new StubSessionChangeTracker()
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-6' },
    })
    const { svc, history } = makeServiceWithHistory(client, tracker)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      const side = await svc.forkSideTask(s.id, { text: 'quoted text', label: 'quote summary' })
      // Sending the prefill untouched carries no user prose — neither derive
      // nor AI generation may consume their one-shot attempt on it.
      await side.sendPrompt('> quoted text\n> nothing else')
      await new Promise((r) => setTimeout(r, 0))

      expect(history.get('agent-side-6')?.title).toBe('quote summary')
    } finally {
      svc.dispose()
    }
  })
})

describe('AcpSessionService — startup timeout', () => {
  it('seals the session as errored when the agent never answers initialize', async () => {
    const client = new FakeAcpClientService({ stubOptions: { initializeHangs: true } })
    const config = new ConfigurationService()
    await config.update('acp.startupTimeoutMs', 50)
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    // createSession returns synchronously now; the handshake fails in the
    // background after the startup timeout fires, sealing the session via
    // failConnection (status → 'errored' + an '[error]' message) rather than
    // rejecting the createSession promise.
    const s = await svc.createSession()
    await s.whenConnected()
    expect(s.status.get()).toBe('errored')
    expect(s.messages.get().at(-1)?.text).toMatch(/timed out/)
    // The failed handshake is captured in the create profile ring buffer.
    const failed = svc.getSessionCreateProfiles().at(-1)
    expect(failed?.failed).toMatch(/timed out/)
    expect(failed?.steps.map((st) => st.name)).not.toContain('didNewSession')
    svc.dispose()
  })

  it('does not lose or hang a prompt queued before a failed connection', async () => {
    const client = new FakeAcpClientService({ stubOptions: { initializeHangs: true } })
    const config = new ConfigurationService()
    await config.update('acp.startupTimeoutMs', 50)
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    const s = await svc.createSession()
    // Submit a prompt while still connecting — it is buffered by the connection
    // state machine. This fire-and-forget promise must settle (never hang) even
    // when the connection ultimately fails.
    const queued = s.sendPrompt('do the thing')
    // The user's message surfaces immediately regardless of connection state.
    expect(s.messages.get().some((m) => m.role === 'user' && m.text === 'do the thing')).toBe(true)
    await s.whenConnected()
    // The queued prompt promise settles (the prior implementation could leave it
    // pending forever); the connection failure is visible as an [error] message.
    await expect(queued).resolves.toBeUndefined()
    expect(s.status.get()).toBe('errored')
    expect(s.messages.get().some((m) => m.text.startsWith('[error]'))).toBe(true)
    // The queued prompt was never dispatched onto a dead connection.
    expect(client.connected[0]?.agent.promptCalls).toEqual([])
    svc.dispose()
  })
})

describe('AcpSessionService — mcpServers capability gating', () => {
  function makeService(
    client: FakeAcpClientService,
    config: ConfigurationService,
    compactionStats: AcpCompactionStatsService = makeCompactionStats(),
    extensionMcp: StubExtensionMcpServersService = new StubExtensionMcpServersService(),
    enablement: StubMcpServerEnablementService = new StubMcpServerEnablementService(),
  ) {
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    return new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        compactionStats,
      ),
      new StubFileService(),
      extensionMcp,
      enablement,
      stubWindowsService(),
    )
  }

  it('forwards normalized stdio servers and drops http when the agent lacks the capability', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: ['srv.js'], env: { TOKEN: 'x' } },
      docs: { type: 'http', url: 'https://docs', headers: { Auth: 'k' } },
    })
    const svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers).toEqual([
      { name: 'fs', command: 'node', args: ['srv.js'], env: [{ name: 'TOKEN', value: 'x' }] },
    ])
    svc.dispose()
  })

  it('a session created right after an acp.mcpServers edit is not filtered by the stale mirror pool', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    const svc = makeService(client, config)
    await config.update('acp.mcpServers', {
      'universe-editor': { command: 'node', args: ['noop.cjs'] },
    })
    // Let the config-change mirror refresh land first, then force the mirror
    // back to its pre-edit value — simulating the fs race where session/new
    // resolves its wire list before the refresh completes.
    await new Promise((resolve) => setTimeout(resolve, 0))
    svc.mcpServerDefinitions.set([], undefined)
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers.map((m) => m.name)).toEqual(['universe-editor'])
    svc.dispose()
  })

  it('merges settings layers per server name: workspace overrides only the same-named user entry', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    config.loadLayer(ConfigurationTarget.User, {
      'acp.mcpServers': {
        fs: { command: 'node', args: ['user.js'] },
        docs: { command: 'npx', args: ['docs'] },
      },
    })
    config.loadLayer(ConfigurationTarget.Project, {
      'acp.mcpServers': {
        fs: { command: 'node', args: ['workspace.js'] },
      },
    })
    const svc = makeService(client, config)
    // User-only entry survives alongside the workspace override; attribution
    // follows the winning layer.
    expect(svc.mcpServerDefinitions.get()).toEqual([
      {
        name: 'fs',
        transport: 'stdio',
        disabled: false,
        source: 'project',
        hasUserLevelDefinition: true,
      },
      {
        name: 'docs',
        transport: 'stdio',
        disabled: false,
        source: 'global',
        hasUserLevelDefinition: true,
      },
    ])
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers).toEqual([
      { name: 'fs', command: 'node', args: ['workspace.js'], env: [] },
      { name: 'docs', command: 'npx', args: ['docs'], env: [] },
    ])
    svc.dispose()
  })

  it('extension-contributed servers reach the wire as the lowest-priority layer', async () => {
    const client = new FakeAcpClientService()
    const extensionMcp = new StubExtensionMcpServersService()
    extensionMcp.setRecord({
      'universe-editor': {
        command: '/app/editor',
        args: ['bridge.mjs'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    })
    const svc = makeService(client, new ConfigurationService(), makeCompactionStats(), extensionMcp)
    expect(svc.mcpServerDefinitions.get()).toEqual([
      {
        name: 'universe-editor',
        transport: 'stdio',
        disabled: false,
        source: 'extension',
        hasUserLevelDefinition: true,
      },
    ])
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers).toEqual([
      {
        name: 'universe-editor',
        command: '/app/editor',
        args: ['bridge.mjs'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
      },
    ])
    svc.dispose()
  })

  it('a same-named user settings entry overrides the extension-contributed server', async () => {
    const client = new FakeAcpClientService()
    const extensionMcp = new StubExtensionMcpServersService()
    extensionMcp.setRecord({ bridge: { command: '/app/editor', args: ['ext.mjs'] } })
    const config = new ConfigurationService()
    config.loadLayer(ConfigurationTarget.User, {
      'acp.mcpServers': { bridge: { command: 'node', args: ['user.js'] } },
    })
    const svc = makeService(client, config, makeCompactionStats(), extensionMcp)
    expect(svc.mcpServerDefinitions.get()).toEqual([
      {
        name: 'bridge',
        transport: 'stdio',
        disabled: false,
        source: 'global',
        hasUserLevelDefinition: true,
      },
    ])
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers).toEqual([
      { name: 'bridge', command: 'node', args: ['user.js'], env: [] },
    ])
    svc.dispose()
  })

  it('refreshes the pool when the extension record changes; vanished servers leave the wire', async () => {
    const client = new FakeAcpClientService()
    const extensionMcp = new StubExtensionMcpServersService()
    const svc = makeService(client, new ConfigurationService(), makeCompactionStats(), extensionMcp)
    expect(svc.mcpServerDefinitions.get()).toEqual([])

    extensionMcp.setRecord({ bridge: { command: '/app/editor' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(svc.mcpServerDefinitions.get()).toEqual([
      {
        name: 'bridge',
        transport: 'stdio',
        disabled: false,
        source: 'extension',
        hasUserLevelDefinition: true,
      },
    ])

    extensionMcp.setRecord({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(svc.mcpServerDefinitions.get()).toEqual([])
    const s = await svc.createSession()
    await s.whenConnected()
    expect(client.connected[0]!.agent.newSessionCalls[0]!.mcpServers).toEqual([])
    svc.dispose()
  })

  it('enablement overrides apply to extension entries (source-agnostic) and refresh the pool', async () => {
    const extensionMcp = new StubExtensionMcpServersService()
    extensionMcp.setRecord({ bridge: { command: '/app/editor' } })
    const enablement = new StubMcpServerEnablementService()
    const svc = makeService(
      new FakeAcpClientService(),
      new ConfigurationService(),
      makeCompactionStats(),
      extensionMcp,
      enablement,
    )
    await enablement.setEnabled('bridge', false, StorageScope.GLOBAL)
    // The pool mirror picks the override up via the enablement change event.
    await vi.waitFor(() => {
      expect(svc.mcpServerDefinitions.get()).toEqual([
        {
          name: 'bridge',
          transport: 'stdio',
          disabled: true,
          source: 'extension',
          hasUserLevelDefinition: true,
        },
      ])
    })
    svc.dispose()
  })

  it('keeps http servers when the agent advertises mcpCapabilities.http', async () => {
    const client = new FakeAcpClientService({ stubOptions: { mcpCapabilities: { http: true } } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      docs: { type: 'http', url: 'https://docs', headers: {} },
    })
    const svc = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers).toEqual([
      { type: 'http', name: 'docs', url: 'https://docs', headers: [] },
    ])
    svc.dispose()
  })

  it('asks the agent to emit only the SDK system-init message via session/new _meta', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params._meta).toEqual({
      claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'init' }] },
    })
    svc.dispose()
  })

  it('seeds mcpServers from config and refreshes status from the init snapshot', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', { fs: { command: 'node', args: [] } })
    const svc = makeService(client, config)
    const session = await svc.createSession()
    await session.whenConnected()
    expect(session.mcpServers.get()).toEqual([
      { name: 'fs', status: 'pending', transport: 'stdio' },
    ])
    svc.onExtNotification('_claude/sdkMessage', {
      sessionId: session.id,
      message: {
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'fs', status: 'connected' }],
      },
    })
    expect(session.mcpServers.get()).toEqual([
      { name: 'fs', status: 'connected', transport: 'stdio' },
    ])
    svc.dispose()
  })

  it('ignores non-init / malformed extNotification payloads', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    svc.onExtNotification('_claude/sdkMessage', {
      sessionId: session.id,
      message: { type: 'result' },
    })
    svc.onExtNotification('_other/method', { sessionId: session.id })
    expect(session.mcpServers.get()).toEqual([])
    svc.dispose()
  })

  it('routes _universe/compaction notifications to a timeline slot that settles in place', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-1',
      phase: 'start',
    })
    const running = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ kind: 'compaction', compaction: { phase: 'running' } })

    // The terminal event shares the id, so it replaces the running slot in place
    // rather than appending a second card.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-1',
      phase: 'success',
    })
    const settled = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ kind: 'compaction', compaction: { phase: 'success' } })
    svc.dispose()
  })

  it('carries the failure reason on a failed compaction', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-2',
      phase: 'failed',
      reason: 'boom',
    })
    const slot = session.timeline.get().find((it) => it.kind === 'compaction')
    expect(slot).toMatchObject({
      kind: 'compaction',
      compaction: { phase: 'failed', reason: 'boom' },
    })
    svc.dispose()
  })

  it('ignores malformed _universe/compaction payloads', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    // Missing id.
    svc.onExtNotification('_universe/compaction', { sessionId: session.id, phase: 'start' })
    // Unknown phase.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-x',
      phase: 'bogus',
    })
    expect(session.timeline.get().filter((it) => it.kind === 'compaction')).toEqual([])
    svc.dispose()
  })

  it('records the duration of a successful compaction back to the stats service', async () => {
    const client = new FakeAcpClientService()
    const stats = makeCompactionStats()
    const recorded: Array<{ agentId: string; durationMs: number }> = []
    const origRecord = stats.record.bind(stats)
    stats.record = (agentId: string, durationMs: number) => {
      recorded.push({ agentId, durationMs })
      origRecord(agentId, durationMs)
    }
    const svc = makeService(client, new ConfigurationService(), stats)
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-record',
      phase: 'start',
    })
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-record',
      phase: 'success',
    })
    // A settled success feeds the per-agent history so the next run can estimate.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.agentId).toBe(session.agentId)
    expect(recorded[0]!.durationMs).toBeGreaterThanOrEqual(0)
    svc.dispose()
  })

  it('seeds expectedDurationMs on a running compaction from recorded history', async () => {
    const client = new FakeAcpClientService()
    const stats = makeCompactionStats()
    const svc = makeService(client, new ConfigurationService(), stats)
    const session = await svc.createSession()
    await session.whenConnected()
    // Pre-seed history for this agent so the running card carries an estimate.
    stats.record(session.agentId, 8000)

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-seed',
      phase: 'start',
    })
    const running = session.timeline.get().find((it) => it.kind === 'compaction')
    expect(running).toMatchObject({
      kind: 'compaction',
      compaction: { phase: 'running', expectedDurationMs: 8000 },
    })
    svc.dispose()
  })

  it('does not record a failed compaction into stats history', async () => {
    const client = new FakeAcpClientService()
    const stats = makeCompactionStats()
    const svc = makeService(client, new ConfigurationService(), stats)
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-fail',
      phase: 'start',
    })
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-fail',
      phase: 'failed',
      reason: 'boom',
    })
    expect(stats.getExpectedDurationMs(session.agentId)).toBeUndefined()
    svc.dispose()
  })

  it('merges a restarted compaction into the stuck-running orphan slot', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    // The agent dies mid-compaction: the settle for cmp-a never arrives.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-a',
      phase: 'start',
    })
    const beforeIdx = session.timeline.get().findIndex((it) => it.kind === 'compaction')

    // After recovery the agent compacts again, reporting under a fresh id.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-b',
      phase: 'start',
    })
    const items = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      id: 'compaction:cmp-b',
      compaction: { phase: 'running' },
    })
    // The merged card keeps the orphan's timeline position instead of jumping
    // to the end.
    expect(session.timeline.get().findIndex((it) => it.kind === 'compaction')).toBe(beforeIdx)
    svc.dispose()
  })

  it('settles a stuck-running orphan when the terminal event arrives under a fresh id', async () => {
    const client = new FakeAcpClientService()
    const stats = makeCompactionStats()
    const recorded: number[] = []
    const origRecord = stats.record.bind(stats)
    stats.record = (agentId: string, durationMs: number) => {
      recorded.push(durationMs)
      origRecord(agentId, durationMs)
    }
    const svc = makeService(client, new ConfigurationService(), stats)
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-a',
      phase: 'start',
    })
    // e.g. a replayed isolated success, or a settle that outlived its start.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-b',
      phase: 'success',
    })
    const items = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      id: 'compaction:cmp-b',
      compaction: { phase: 'success' },
    })
    expect(recorded).toHaveLength(1)
    svc.dispose()
  })

  it('keeps an isolated terminal compaction appended when no orphan is running', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    // The replay path reports a settled compaction with no preceding start.
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-replay',
      phase: 'success',
    })
    const items = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      id: 'compaction:cmp-replay',
      compaction: { phase: 'success' },
    })
    svc.dispose()
  })

  it('treats a duplicate start for the same id as an in-place reset, not a second card', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-dup',
      phase: 'start',
    })
    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-dup',
      phase: 'start',
    })
    const items = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'compaction', compaction: { phase: 'running' } })
    svc.dispose()
  })

  it('settles a stuck-running orphan as failed when reconnect recovery is sealed', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/compaction', {
      sessionId: session.id,
      id: 'cmp-seal',
      phase: 'start',
    })
    ;(session as AcpSession).sealRecoveryFailure('connection lost')
    const items = session.timeline.get().filter((it) => it.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'compaction',
      compaction: { phase: 'failed', reason: 'reconnect failed' },
    })
    svc.dispose()
  })

  it('routes _universe/sessionResurrection notifications to a timeline slot that settles in place', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()

    svc.onExtNotification('_universe/sessionResurrection', {
      sessionId: session.id,
      id: 'res-1',
      phase: 'start',
      replayCount: 2,
    })
    const running = session.timeline.get().filter((it) => it.kind === 'resurrection')
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({
      kind: 'resurrection',
      resurrection: { phase: 'running', replayCount: 2 },
    })

    // The terminal event shares the id, so it replaces the running slot in place
    // rather than appending a second card.
    svc.onExtNotification('_universe/sessionResurrection', {
      sessionId: session.id,
      id: 'res-1',
      phase: 'success',
      replayCount: 2,
    })
    const settled = session.timeline.get().filter((it) => it.kind === 'resurrection')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({
      kind: 'resurrection',
      resurrection: { phase: 'success', replayCount: 2 },
    })
    svc.dispose()
  })

  it('carries the failure reason on a failed resurrection', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    svc.onExtNotification('_universe/sessionResurrection', {
      sessionId: session.id,
      id: 'res-2',
      phase: 'failed',
      reason: 'resume failed',
    })
    const slot = session.timeline.get().find((it) => it.kind === 'resurrection')
    expect(slot).toMatchObject({
      kind: 'resurrection',
      resurrection: { phase: 'failed', reason: 'resume failed' },
    })
    svc.dispose()
  })

  it('ignores malformed _universe/sessionResurrection payloads', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    // Missing id.
    svc.onExtNotification('_universe/sessionResurrection', {
      sessionId: session.id,
      phase: 'start',
    })
    // Unknown phase.
    svc.onExtNotification('_universe/sessionResurrection', {
      sessionId: session.id,
      id: 'res-x',
      phase: 'bogus',
    })
    expect(session.timeline.get().filter((it) => it.kind === 'resurrection')).toEqual([])
    svc.dispose()
  })

  it('attributes MCP tool calls to their server from _meta.claudeCode.toolName', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(client, new ConfigurationService())
    const session = await svc.createSession()
    await session.whenConnected()
    client.connected[0]!.sink.onSessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'query',
        kind: 'other',
        status: 'pending',
        _meta: { claudeCode: { toolName: 'mcp__sqlite__query' } },
      },
    })
    expect(session.toolCalls.get()[0]?.mcpServer).toBe('sqlite')
    svc.dispose()
  })
})

describe('AcpSessionService — session MCP selection', () => {
  afterEach(() => AcpPromptDraftCache._resetForTests())

  function makeService(client: FakeAcpClientService, config: ConfigurationService) {
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService()
    const history = makeHistory()
    const agentDefaults = makeAgentDefaults()
    const enablement = new StubMcpServerEnablementService()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      enablement,
      stubWindowsService(),
    )
    return { svc, history, agentDefaults, enablement }
  }

  it('sends all non-disabled pool servers when the session inherits', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: ['fs.js'] },
      web: { command: 'node', args: ['web.js'] },
    })
    const { svc, enablement } = makeService(client, config)
    await enablement.setEnabled('web', false, StorageScope.GLOBAL)
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers.map((m) => m.name)).toEqual(['fs'])
    expect(s.mcpServerSelection.get()).toBeNull()
    svc.dispose()
  })

  it('seamlessly reloads on an explicit pin and updates the history row', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc, history } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    // Give the session real content: an empty session is replaced instead of
    // resumed (see the empty-session case below).
    await s.sendPrompt('first turn')
    const sid = s.sessionIdOnAgent.get()!

    svc.setSessionMcpServers(s.id, ['fs'])

    // Reload is fire-and-forget: close + resume via session/load on a new
    // connection, with the narrowed wire list.
    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      expect(client.connected[1]!.agent.loadSessionCalls).toHaveLength(1)
    })
    const loadParams = client.connected[1]!.agent.loadSessionCalls[0]!
    expect(loadParams.sessionId).toBe(sid)
    expect(loadParams.mcpServers.map((m) => m.name)).toEqual(['fs'])
    expect(history.get(sid)?.mcpServerNames).toEqual(['fs'])
    const resumed = svc.getById(sid)
    expect(resumed?.mcpServerSelection.get()).toEqual(['fs'])
    expect(svc.activeSession.get()?.id).toBe(sid)
    svc.dispose()
  })

  it('replaces an empty session instead of resuming it on an explicit pin', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc, history } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    const sid = s.sessionIdOnAgent.get()!
    const title = s.title

    // Never messaged: the agent has nothing to session/load, so the reload
    // swaps in a fresh session pinned to the new selection.
    svc.setSessionMcpServers(s.id, ['fs'])

    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      const active = svc.activeSession.get()
      expect(active).toBeDefined()
      expect(active!.status.get()).toBe('idle')
    })
    // No session/load anywhere; the replacement went through session/new with
    // the narrowed wire list.
    expect(client.connected.flatMap((c) => c.agent.loadSessionCalls)).toHaveLength(0)
    expect(client.connected[0]!.agent.newSessionCalls).toHaveLength(1)
    expect(client.connected[1]!.agent.newSessionCalls).toHaveLength(1)
    const newParams = client.connected[1]!.agent.newSessionCalls[0]!
    expect(newParams.mcpServers.map((m) => m.name)).toEqual(['fs'])
    // The replacement is active, keeps the old title, and the history row was
    // swapped (old row removed, new row pinned).
    const active = svc.activeSession.get()!
    expect(active.id).not.toBe(s.id)
    expect(active.title).toBe(title)
    expect(history.get(sid)).toBeUndefined()
    const newSid = active.sessionIdOnAgent.get()!
    expect(newSid).not.toBe(sid)
    expect(history.get(newSid)?.mcpServerNames).toEqual(['fs'])
    svc.dispose()
  })

  it('resetting to inherit reloads back to the full wire list and clears the pin', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc, history } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    await s.sendPrompt('first turn')
    const sid = s.sessionIdOnAgent.get()!

    // Narrow first so the reset back to inherit is itself a divergence.
    svc.setSessionMcpServers(s.id, ['fs'])
    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      expect(client.connected[1]!.agent.loadSessionCalls).toHaveLength(1)
    })
    expect(client.connected[1]!.agent.loadSessionCalls[0]!.mcpServers.map((m) => m.name)).toEqual([
      'fs',
    ])

    svc.setSessionMcpServers(sid, null)

    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(3)
      expect(client.connected[2]!.agent.loadSessionCalls).toHaveLength(1)
    })
    const loadParams = client.connected[2]!.agent.loadSessionCalls[0]!
    expect(loadParams.mcpServers.map((m) => m.name)).toEqual(['fs', 'docs'])
    expect(history.get(sid)?.mcpServerNames).toBeUndefined()
    expect(svc.getById(sid)?.mcpServerSelection.get()).toBeNull()
    svc.dispose()
  })

  it('applies the history pin to session/load on resume', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc, history } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    const sid = s.sessionIdOnAgent.get()!
    history.setHistoryMcpServerNames(sid, ['fs'])
    await svc.closeSession(sid)

    const resumed = await svc.resumeSession(sid)
    expect(resumed.mcpServerSelection.get()).toEqual(['fs'])
    const loadParams = client.connected[1]!.agent.loadSessionCalls[0]!
    expect(loadParams.mcpServers.map((m) => m.name)).toEqual(['fs'])
    svc.dispose()
  })

  it('does not reload when the selection still matches the attach snapshot', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    await s.sendPrompt('first turn')
    const sid = s.sessionIdOnAgent.get()!

    // Narrow to ['fs']: one reload, after which the attach snapshot IS ['fs'].
    svc.setSessionMcpServers(s.id, ['fs'])
    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      expect(client.connected[1]!.agent.loadSessionCalls).toHaveLength(1)
    })
    expect(svc.getById(sid)?.status.get()).toBe('idle')

    // Re-assert the same pin: it already matches the attach snapshot, so no
    // second reload may be scheduled.
    svc.setSessionMcpServers(sid, ['fs'])
    await new Promise((r) => setTimeout(r, 0))
    expect(client.connected).toHaveLength(2)
    expect(svc.getById(sid)?.status.get()).toBe('idle')
    svc.dispose()
  })

  it('a session pin does not leak into the next new session', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()

    // Narrow this session to ['fs'] — the pin is session-scoped only…
    svc.setSessionMcpServers(s.id, ['fs'])
    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
    })

    // …so the next new session still starts with the full non-disabled pool.
    const s2 = await svc.createSession()
    await s2.whenConnected()
    const params = client.connected[2]!.agent.newSessionCalls[0]!
    expect(params.mcpServers.map((m) => m.name)).toEqual(['fs', 'docs'])
    svc.dispose()
  })

  it('a workspace enablement override wins over the global one for new sessions', async () => {
    const client = new FakeAcpClientService()
    const config = new ConfigurationService()
    await config.update(
      'acp.mcpServers',
      {
        fs: { command: 'node', args: [] },
        docs: { command: 'node', args: [] },
      },
      ConfigurationTarget.User,
    )
    const { svc, enablement } = makeService(client, config)
    // Global default: fs disabled. Workspace re-enables it and disables docs.
    await enablement.setEnabled('fs', false, StorageScope.GLOBAL)
    await enablement.setEnabled('fs', true, StorageScope.WORKSPACE)
    await enablement.setEnabled('docs', false, StorageScope.WORKSPACE)
    const s = await svc.createSession()
    await s.whenConnected()
    const params = client.connected[0]!.agent.newSessionCalls[0]!
    expect(params.mcpServers.map((m) => m.name)).toEqual(['fs'])
    // Settings stay untouched — enablement lives in storage, not in entries.
    expect(config.getLayerSnapshot(ConfigurationTarget.User)['acp.mcpServers']).toEqual({
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    svc.dispose()
  })

  it('carries the unsent prompt draft over the seamless reload', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    await s.sendPrompt('first turn')
    const sid = s.sessionIdOnAgent.get()!
    AcpPromptDraftCache.save(s.id, { text: 'half-typed follow-up', caret: 19 })

    svc.setSessionMcpServers(s.id, ['fs'])

    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      expect(client.connected[1]!.agent.loadSessionCalls).toHaveLength(1)
    })
    // The reload swapped the session object; the draft must be reachable under
    // the resumed session's id so the remounted prompt input restores it.
    const resumed = svc.getById(sid)!
    expect(AcpPromptDraftCache.load(resumed.id)?.text).toBe('half-typed follow-up')
    expect(AcpPromptDraftCache.load(s.id)).toBeUndefined()
    svc.dispose()
  })

  it('carries the unsent prompt draft to the replacement of an empty session', async () => {
    const client = new FakeAcpClientService({ stubOptions: { loadSession: true } })
    const config = new ConfigurationService()
    await config.update('acp.mcpServers', {
      fs: { command: 'node', args: [] },
      docs: { command: 'node', args: [] },
    })
    const { svc } = makeService(client, config)
    const s = await svc.createSession()
    await s.whenConnected()
    AcpPromptDraftCache.save(s.id, { text: 'half-typed first message' })

    svc.setSessionMcpServers(s.id, ['fs'])

    await vi.waitFor(() => {
      expect(client.connected).toHaveLength(2)
      const active = svc.activeSession.get()
      expect(active).toBeDefined()
      expect(active!.status.get()).toBe('idle')
    })
    const active = svc.activeSession.get()!
    expect(active.id).not.toBe(s.id)
    expect(AcpPromptDraftCache.load(active.id)?.text).toBe('half-typed first message')
    expect(AcpPromptDraftCache.load(s.id)).toBeUndefined()
    svc.dispose()
  })
})

class FixedTitleService implements IAcpSessionTitleService {
  declare readonly _serviceBrand: undefined
  constructor(private readonly _title: string) {}
  generateTitle(): Promise<string | undefined> {
    return Promise.resolve(this._title)
  }
}

describe('AcpSessionService — AI session title push-back', () => {
  function makeServiceWithTitle(
    client: FakeAcpClientService,
    title: IAcpSessionTitleService,
  ): { svc: AcpSessionService; history: AcpSessionHistoryService } {
    const history = makeHistory()
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService() as ITelemetryService
    const agentDefaults = makeAgentDefaults()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        title,
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    return { svc, history }
  }

  it('pushes the AI title to the agent and flags the history row', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('Fix login bug'))
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      await session.sendPrompt('how do I fix the broken login page?')
      // _maybeGenerateTitle is fire-and-forget; let the microtasks drain.
      await new Promise((r) => setTimeout(r, 0))

      const agent = client.connected[0]!.agent
      const sid = session.sessionIdOnAgent.get()!
      expect(agent.extMethodCalls).toContainEqual({
        method: 'universe-editor/set_session_title',
        params: { sessionId: sid, title: 'Fix login bug' },
      })
      const entry = history.get(sid)
      expect(entry?.title).toBe('Fix login bug')
      expect(entry?.aiTitle).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('does not push the first-prompt-derived title (only AI titles)', async () => {
    const client = new FakeAcpClientService()
    // Title service returns undefined → session keeps the first-prompt fallback.
    const { svc } = makeServiceWithTitle(client, new StubSessionTitleService())
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      await session.sendPrompt('just a first prompt')
      await new Promise((r) => setTimeout(r, 0))

      const agent = client.connected[0]!.agent
      expect(agent.extMethodCalls).toHaveLength(0)
    } finally {
      svc.dispose()
    }
  })

  it('renameSession pushes the manual title, flags the row, and blocks AI regeneration', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('AI Generated'))
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!

      const applied = svc.renameSession(session.id, '  My Custom  Name  ')
      expect(applied).toBe(true)
      // _pushTitleToAgent is fire-and-forget over the in-memory pair; drain it.
      await new Promise((r) => setTimeout(r, 0))

      const agent = client.connected[0]!.agent
      expect(agent.extMethodCalls).toContainEqual({
        method: 'universe-editor/set_session_title',
        params: { sessionId: sid, title: 'My Custom Name' },
      })
      expect(history.get(sid)?.title).toBe('My Custom Name')
      expect(history.get(sid)?.manualTitle).toBe(true)

      // A first prompt afterwards must NOT let the AI title overwrite the manual one.
      await session.sendPrompt('do the thing')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.title).toBe('My Custom Name')
    } finally {
      svc.dispose()
    }
  })

  it('renameSession rejects blank titles', async () => {
    const client = new FakeAcpClientService()
    const { svc } = makeServiceWithTitle(client, new StubSessionTitleService())
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      expect(svc.renameSession(session.id, '   ')).toBe(false)
    } finally {
      svc.dispose()
    }
  })

  it('session_info_update does not clobber an AI-flagged title', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('Fix login bug'))
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      await session.sendPrompt('how do I fix the broken login page?')
      await new Promise((r) => setTimeout(r, 0))
      const sid = session.sessionIdOnAgent.get()!
      expect(history.get(sid)?.aiTitle).toBe(true)

      // The agent reports its SDK summary (the raw first prompt) at turn end —
      // e.g. after /compact reset it. The AI title must survive.
      client.connected[0]!.sink.onSessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: 'session_info_update',
          title: 'how do I fix the broken login page?',
          updatedAt: new Date().toISOString(),
        },
      })
      expect(history.get(sid)?.title).toBe('Fix login bug')
    } finally {
      svc.dispose()
    }
  })

  it('does not spend title derivation/generation on a local built-in command prompt', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('Real Task Title'))
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!

      // `/model opus` is handled locally by the agent — a throwaway turn. It
      // must not become the title, nor consume the one-shot AI generation.
      await session.sendPrompt('/model opus')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.title).not.toBe('/model opus')
      expect(history.get(sid)?.aiTitle).not.toBe(true)

      // The first real prompt derives + generates as if it were the first.
      await session.sendPrompt('fix the flaky scroll test')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.title).toBe('Real Task Title')
      expect(history.get(sid)?.aiTitle).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('retries AI title generation on the next prompt when the first attempt yields nothing', async () => {
    const client = new FakeAcpClientService()
    let calls = 0
    const flaky: IAcpSessionTitleService = {
      _serviceBrand: undefined,
      generateTitle: () => Promise.resolve(++calls === 1 ? undefined : 'Retry Title'),
    }
    const { svc, history } = makeServiceWithTitle(client, flaky)
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!

      await session.sendPrompt('first prompt')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.aiTitle).not.toBe(true)

      await session.sendPrompt('second prompt')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.title).toBe('Retry Title')
      expect(history.get(sid)?.aiTitle).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('forkSideTask resumes the child with the title service and AI-generates its title', async () => {
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-ai' },
    })
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('Scroll Logic Q&A'))
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')

      const side = await svc.forkSideTask(s.id, { text: 'quoted text', label: 'quote summary' })
      // The quote-label placeholder must be replaced by the AI title once the
      // first real turn lands — and the generation reads the question, not the
      // leading quote block.
      await side.sendPrompt('> quoted text\n\nhow does the scroll compensation work?')
      await new Promise((r) => setTimeout(r, 0))

      const entry = history.get('agent-side-ai')
      expect(entry?.title).toBe('Scroll Logic Q&A')
      expect(entry?.aiTitle).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('feeds the side-task quote as context to the title generation', async () => {
    const client = new FakeAcpClientService({
      stubOptions: { forkCapable: true, loadSession: true, forkedSessionId: 'agent-side-ctx' },
    })
    let seen: Parameters<IAcpSessionTitleService['generateTitle']>[2] | undefined
    const recording: IAcpSessionTitleService = {
      _serviceBrand: undefined,
      generateTitle: (_user, _agent, options) => {
        seen = options
        return Promise.resolve('Side Title')
      },
    }
    const { svc } = makeServiceWithTitle(client, recording)
    try {
      const s = await svc.createSession('claude-code')
      await s.whenConnected()
      await s.sendPrompt('first turn')
      await new Promise((r) => setTimeout(r, 0))
      // A regular session has no quote — the context must stay empty.
      expect(seen?.context?.quotedText).toBeUndefined()

      const side = await svc.forkSideTask(s.id, { text: 'const x = scrollTop', label: 'quote' })
      await side.sendPrompt('why does this jump?')
      await new Promise((r) => setTimeout(r, 0))
      expect(seen?.context?.quotedText).toBe('const x = scrollTop')
    } finally {
      svc.dispose()
    }
  })
})

describe('AcpSessionService — first prompt history mirror', () => {
  function makeServiceWithTitle(
    client: FakeAcpClientService,
    title: IAcpSessionTitleService,
  ): { svc: AcpSessionService; history: AcpSessionHistoryService } {
    const history = makeHistory()
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService() as ITelemetryService
    const agentDefaults = makeAgentDefaults()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        title,
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    return { svc, history }
  }

  it('records the full first prompt and keeps it across later prompts and an AI title', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new FixedTitleService('AI Title'))
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!

      await session.sendPrompt('multi-line first prompt\nsecond line of it')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.firstPrompt).toBe('multi-line first prompt\nsecond line of it')
      // The AI title replaced the derived one — the firstPrompt mirror must stand.
      expect(history.get(sid)?.title).toBe('AI Title')

      await session.sendPrompt('a later prompt')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.firstPrompt).toBe('multi-line first prompt\nsecond line of it')
    } finally {
      svc.dispose()
    }
  })

  it('records a first prompt sent while the session is still connecting', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new StubSessionTitleService())
    try {
      const session = await svc.createSession()
      // Sent before attach: the history row does not exist yet, so the record
      // must be buffered and re-applied once the connection lands.
      await session.sendPrompt('queued while connecting')
      await session.whenConnected()
      await new Promise((r) => setTimeout(r, 0))

      const sid = session.sessionIdOnAgent.get()!
      expect(history.get(sid)?.firstPrompt).toBe('queued while connecting')
    } finally {
      svc.dispose()
    }
  })

  it('skips local built-in command prompts when recording the first prompt', async () => {
    const client = new FakeAcpClientService()
    const { svc, history } = makeServiceWithTitle(client, new StubSessionTitleService())
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!

      await session.sendPrompt('/model opus')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.firstPrompt).toBeUndefined()

      await session.sendPrompt('the real first prompt')
      await new Promise((r) => setTimeout(r, 0))
      expect(history.get(sid)?.firstPrompt).toBe('the real first prompt')
    } finally {
      svc.dispose()
    }
  })
})

describe('AcpSessionService — configOptions history snapshot', () => {
  // Codex's protocol ids: `model` + `reasoning_effort` (see vendor/codex-acp).
  const CODEX_CONFIG: readonly SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5-codex',
      options: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }],
    } as unknown as SessionConfigOption,
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [{ value: 'high', name: 'high' }],
    } as unknown as SessionConfigOption,
  ]

  function makeServiceWithHistory(client: FakeAcpClientService) {
    const history = makeHistory()
    const notification = new StubNotificationService()
    const telemetry = new NoopTelemetryService()
    const agentDefaults = makeAgentDefaults()
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      notification,
      telemetry,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      agentDefaults,
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notification, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        telemetry,
        history,
        agentDefaults,
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
    return { svc, history }
  }

  it('snapshots the default model + reasoning_effort (value AND label) into history on createSession', async () => {
    const client = new FakeAcpClientService({
      stubOptions: { newSessionConfigOptions: CODEX_CONFIG },
    })
    const { svc, history } = makeServiceWithHistory(client)
    try {
      const session = await svc.createSession()
      await session.whenConnected()
      const sid = session.sessionIdOnAgent.get()!
      const entry = history.get(sid)
      expect(entry?.configOptions).toEqual({ model: 'gpt-5-codex', reasoning_effort: 'high' })
      expect(entry?.configLabels).toEqual({ model: 'GPT-5 Codex', reasoning_effort: 'high' })
    } finally {
      svc.dispose()
    }
  })
})

describe('AcpSessionService — stall watchdog', () => {
  const STALL_TIMEOUT_MS = 30_000

  function makeService(
    stallMs: number = STALL_TIMEOUT_MS,
    client: FakeAcpClientService = new FakeAcpClientService({ stubOptions: { promptHangs: true } }),
  ): AcpSessionService {
    const notifications = new StubNotificationService()
    const config: IConfigurationService = new ConfigurationService()
    void config.update('acp.turnStallTimeoutMs', stallMs, ConfigurationTarget.Memory)
    void config.update('acp.startupTimeoutMs', 5 * 60_000, ConfigurationTarget.Memory)
    return new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        new NoopTelemetryService(),
        makeHistory(),
        makeAgentDefaults(),
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
  }

  async function makeRunningSession(): Promise<{ svc: AcpSessionService; session: AcpSession }> {
    const svc = makeService()
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    void session.sendPrompt('hi')
    // Let the prompt request land so the session flips to running.
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('running')
    return { svc, session }
  }

  function pendingElicitation(): AcpPendingElicitation {
    return {
      request: {},
      resolve: () => {},
      cancel: () => {},
    } as unknown as AcpPendingElicitation
  }

  function pendingPermission(): AcpPendingPermission {
    return {
      toolCallId: 'tc-1',
      title: 'run command',
      options: [{ optionId: 'allow', name: 'Allow' }],
      resolve: () => {},
      cancel: () => {},
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('declares a silent running session stalled past the timeout', async () => {
    const { svc, session } = await makeRunningSession()
    const stallSpy = vi.spyOn(session, 'handleStall')
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 90_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('does not declare a stall right after a prompt dispatched following a long idle gap', async () => {
    // Regression: lastActivityAt used to advance only on inbound updates, so
    // the first prompt after a >stall-timeout idle gap was declared stalled on
    // the very next watchdog tick (silence measured from the PREVIOUS turn's
    // last update) and the shared agent process got killed mid-turn. Dispatch
    // now counts as activity, so silence is measured from the turn start.
    const stallMs = 90_000 // above the 60s watchdog tick so the first tick after dispatch is observable
    const svc = makeService(stallMs)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    const stallSpy = vi.spyOn(session, 'handleStall')

    // Idle (no in-flight turn) far past the stall timeout — the watchdog skips
    // non-running sessions, so nothing fires.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(stallSpy).not.toHaveBeenCalled()

    void session.sendPrompt('hi')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('running')

    // Next tick lands ~40s after the dispatch: well under the stall timeout,
    // no matter how long the session idled before it.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(stallSpy).not.toHaveBeenCalled()

    // But a turn that then stays silent past the timeout still stalls.
    await vi.advanceTimersByTimeAsync(stallMs + 60_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('skips a session awaiting an elicitation answer', async () => {
    const { svc, session } = await makeRunningSession()
    const stallSpy = vi.spyOn(session, 'handleStall')
    session.presentElicitation(pendingElicitation())
    await vi.advanceTimersByTimeAsync(3 * STALL_TIMEOUT_MS)
    expect(stallSpy).not.toHaveBeenCalled()
    expect(session.status.get()).toBe('running')
    svc.dispose()
  })

  it('skips a session awaiting a permission decision', async () => {
    const { svc, session } = await makeRunningSession()
    const stallSpy = vi.spyOn(session, 'handleStall')
    session.presentPermission(pendingPermission())
    await vi.advanceTimersByTimeAsync(3 * STALL_TIMEOUT_MS)
    expect(stallSpy).not.toHaveBeenCalled()
    expect(session.status.get()).toBe('running')
    svc.dispose()
  })

  it('resumes watchdog coverage once the pending card settles', async () => {
    const { svc, session } = await makeRunningSession()
    const stallSpy = vi.spyOn(session, 'handleStall')
    session.presentElicitation(pendingElicitation())
    await vi.advanceTimersByTimeAsync(3 * STALL_TIMEOUT_MS)
    expect(stallSpy).not.toHaveBeenCalled()
    session.pendingElicitation.set(undefined, undefined)
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 90_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('handleStall itself refuses while user input is pending (belt-and-braces)', async () => {
    const { svc, session } = await makeRunningSession()
    session.presentPermission(pendingPermission())
    session.handleStall()
    expect(session.status.get()).toBe('running')
    expect(session.isReconnecting).toBe(false)
    svc.dispose()
  })

  it('skips a session with a compaction in progress', async () => {
    const { svc, session } = await makeRunningSession()
    const stallSpy = vi.spyOn(session, 'handleStall')
    session.applyCompaction('c-1', 'running')
    await vi.advanceTimersByTimeAsync(5 * STALL_TIMEOUT_MS)
    expect(stallSpy).not.toHaveBeenCalled()
    expect(session.status.get()).toBe('running')
    svc.dispose()
  })

  it('does not stall right after a long compaction settles', async () => {
    // Regression: compaction lifecycle travels via ext-notifications, which
    // used to never bump lastActivityAt. After a compaction longer than the
    // stall timeout settled, the silence was still measured from BEFORE the
    // compaction started, so the very next tick declared the turn wedged and
    // killed the agent mid-turn.
    const stallMs = 90_000 // above the 60s watchdog tick so tick alignment can't flake the assertions
    const svc = makeService(stallMs)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    void session.sendPrompt('hi')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('running')
    const stallSpy = vi.spyOn(session, 'handleStall')

    session.applyCompaction('c-1', 'running')
    // A compaction outliving the stall timeout is skipped while running…
    await vi.advanceTimersByTimeAsync(stallMs + 60_000)
    expect(stallSpy).not.toHaveBeenCalled()
    // …and its settle counts as activity, so the post-compaction turn gets a
    // fresh silence window instead of an instant stall.
    session.applyCompaction('c-1', 'success')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stallSpy).not.toHaveBeenCalled()
    // But genuine post-compaction silence still stalls.
    await vi.advanceTimersByTimeAsync(stallMs + 60_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('handleStall itself refuses while a compaction is running (belt-and-braces)', async () => {
    const { svc, session } = await makeRunningSession()
    session.applyCompaction('c-1', 'running')
    session.handleStall()
    expect(session.status.get()).toBe('running')
    expect(session.isReconnecting).toBe(false)
    svc.dispose()
  })

  it('treats a liveness ping ext-notification as activity, with no timeline or output churn', async () => {
    // The codex fork's liveness probe keeps long silent turns (collab
    // sub-agent waits, output-less builds) alive. The ping CANNOT ride
    // session/update: the SDK zod-validates those params against the
    // SessionUpdate union before dispatch, so a private variant is rejected
    // and never reaches any handler (production bug). It travels as a custom
    // `_universe/liveness_ping` notification, which the SDK routes to the
    // client impl's extNotification hook — the channel exercised here. The
    // ping must refresh lastActivityAt while producing no visible output.
    const stallMs = 90_000 // above the 60s watchdog tick so tick alignment can't flake the assertions
    const svc = makeService(stallMs)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    void session.sendPrompt('hi')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('running')
    const stallSpy = vi.spyOn(session, 'handleStall')

    const agentSessionId = session.sessionIdOnAgent.get()
    if (agentSessionId === undefined) throw new Error('expected an attached session')
    const timelineBefore = session.timeline.get().length
    await vi.advanceTimersByTimeAsync(60_000)
    svc.onExtNotification('_universe/liveness_ping', { sessionId: agentSessionId })
    expect(session.timeline.get().length).toBe(timelineBefore)

    // The ping reset the silence window, so the next ticks see no stall…
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stallSpy).not.toHaveBeenCalled()
    // …but genuine silence afterwards still stalls.
    await vi.advanceTimersByTimeAsync(stallMs + 60_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('routes a real-wire _universe/liveness_ping notification from agent to the stall watchdog', async () => {
    // End-to-end over the actual SDK dispatch: a custom-method notification
    // sent by AgentSideConnection.notify() must pass the SDK's validation and
    // land on the client impl's extNotification hook — unlike the old
    // session/update variant, which the SDK rejected with "Invalid params".
    const stallMs = 90_000
    const client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    const svc = makeService(stallMs, client)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    void session.sendPrompt('hi')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('running')
    const stallSpy = vi.spyOn(session, 'handleStall')

    const agentSessionId = session.sessionIdOnAgent.get()
    if (agentSessionId === undefined) throw new Error('expected an attached session')
    const agentConn = client.connected[0]?.agentConn
    if (!agentConn) throw new Error('expected a connected agent')
    await vi.advanceTimersByTimeAsync(60_000)
    await agentConn.notify('_universe/liveness_ping', { sessionId: agentSessionId })
    // Notifications have no response — flush the transform hops.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(stallSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(stallMs + 60_000)
    expect(stallSpy).toHaveBeenCalled()
    svc.dispose()
  })

  it('routes _universe/background_activity to the session, flipping autonomous turns to running', async () => {
    const svc = makeService()
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    expect(session.status.get()).toBe('idle')
    expect(session.backgroundTaskCount.get()).toBe(0)

    const agentSessionId = session.sessionIdOnAgent.get()
    if (agentSessionId === undefined) throw new Error('expected an attached session')
    svc.onExtNotification('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 2,
      autonomousTurn: false,
    })
    // Background tasks alone keep the core status idle — the display layer
    // folds them into 'background'.
    expect(session.status.get()).toBe('idle')
    expect(session.backgroundTaskCount.get()).toBe(2)

    // An autonomous follow-up turn occupies no prompt RPC yet must count as
    // running (its own segment starts here).
    svc.onExtNotification('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 1,
      autonomousTurn: true,
    })
    expect(session.status.get()).toBe('running')
    expect(session.runningStartedAt.get()).toBeTypeOf('number')

    svc.onExtNotification('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 0,
      autonomousTurn: false,
    })
    expect(session.status.get()).toBe('idle')
    expect(session.backgroundTaskCount.get()).toBe(0)
    expect(session.runningStartedAt.get()).toBeUndefined()
    expect(session.accumulatedRunningMs.get()).toBeGreaterThanOrEqual(0)
    svc.dispose()
  })

  it('routes a real-wire _universe/background_activity notification from agent to the session', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(STALL_TIMEOUT_MS, client)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()

    const agentSessionId = session.sessionIdOnAgent.get()
    if (agentSessionId === undefined) throw new Error('expected an attached session')
    const agentConn = client.connected[0]?.agentConn
    if (!agentConn) throw new Error('expected a connected agent')
    await agentConn.notify('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 1,
      autonomousTurn: true,
    })
    // Notifications have no response — flush the transform hops.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(session.status.get()).toBe('running')
    expect(session.backgroundTaskCount.get()).toBe(1)
    svc.dispose()
  })

  it('ignores malformed _universe/background_activity payloads', async () => {
    const svc = makeService()
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()

    const agentSessionId = session.sessionIdOnAgent.get()
    if (agentSessionId === undefined) throw new Error('expected an attached session')
    svc.onExtNotification('_universe/background_activity', { sessionId: agentSessionId })
    svc.onExtNotification('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 'two',
      autonomousTurn: false,
    })
    svc.onExtNotification('_universe/background_activity', {
      sessionId: agentSessionId,
      backgroundTasks: 1,
    })
    svc.onExtNotification('_universe/background_activity', {
      backgroundTasks: 1,
      autonomousTurn: true,
    })
    expect(session.status.get()).toBe('idle')
    expect(session.backgroundTaskCount.get()).toBe(0)
    svc.dispose()
  })

  it('applyBackgroundActivity is a no-op once the session is closed', async () => {
    const svc = makeService()
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    await session.close()

    session.applyBackgroundActivity({ backgroundTasks: 3, autonomousTurn: true })
    expect(session.status.get()).toBe('closed')
    expect(session.backgroundTaskCount.get()).toBe(0)
    svc.dispose()
  })

  it('resets background activity when the connection is lost', async () => {
    const { svc, session } = await makeRunningSession()
    session.applyBackgroundActivity({ backgroundTasks: 2, autonomousTurn: true })
    expect(session.status.get()).toBe('running')
    expect(session.backgroundTaskCount.get()).toBe(2)

    session.handleStall()
    expect(session.isReconnecting).toBe(true)
    expect(session.backgroundTaskCount.get()).toBe(0)
    expect(session.autonomousTurnActive).toBe(false)
    svc.dispose()
  })

  it('watchdog skips a session running only on an autonomous turn', async () => {
    const stallMs = 90_000
    const svc = makeService(stallMs)
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    session.applyBackgroundActivity({ backgroundTasks: 1, autonomousTurn: true })
    expect(session.status.get()).toBe('running')
    expect(session.autonomousTurnActive).toBe(true)
    const stallSpy = vi.spyOn(session, 'handleStall')

    // Far past the stall window with zero wire traffic — the watchdog must not
    // kill a turn that holds no prompt RPC to abort and resume.
    await vi.advanceTimersByTimeAsync(stallMs + 120_000)
    expect(stallSpy).not.toHaveBeenCalled()
    expect(session.isReconnecting).toBe(false)
    svc.dispose()
  })

  it('handleStall itself refuses an autonomous-only running session (belt-and-braces)', async () => {
    const svc = makeService()
    const session = await svc.createSession()
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    session.applyBackgroundActivity({ backgroundTasks: 1, autonomousTurn: true })
    expect(session.status.get()).toBe('running')

    session.handleStall()
    expect(session.status.get()).toBe('running')
    expect(session.isReconnecting).toBe(false)
    svc.dispose()
  })
})

describe('AcpSessionService — idle process reaper', () => {
  const IDLE_MS = 30_000

  function makeService(
    idleMs: number = IDLE_MS,
    client: FakeAcpClientService = new FakeAcpClientService(),
  ): AcpSessionService {
    const notifications = new StubNotificationService()
    const config: IConfigurationService = new ConfigurationService()
    void config.update('acp.idleProcessTimeoutMs', idleMs, ConfigurationTarget.Memory)
    // One history instance shared by the service and the factory-held sessions,
    // like production DI — `setHistoryHasMessages` must land where the reaper
    // reads it.
    const history = makeHistory()
    return new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      FAKE_URI_IDENTITY,
      new AcpAuthGuidanceService(notifications, { executeCommand: async () => undefined } as never),
      new AcpSessionFactory(
        new NoopTelemetryService(),
        history,
        makeAgentDefaults(),
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        makeCompactionStats(),
      ),
      new StubFileService(),
      new StubExtensionMcpServersService(),
      new StubMcpServerEnablementService(),
      stubWindowsService(),
    )
  }

  /** A session that sent one prompt and settled back to idle (hasMessages: true). */
  async function makeIdleSession(svc: AcpSessionService, cwd = '/w'): Promise<AcpSession> {
    const session = await svc.createSession('fake', { cwd })
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    void session.sendPrompt('hi')
    await vi.advanceTimersByTimeAsync(10)
    expect(session.status.get()).toBe('idle')
    return session
  }

  function pendingPermission(): AcpPendingPermission {
    return {
      toolCallId: 'tc-1',
      title: 'run command',
      options: [{ optionId: 'allow', name: 'Allow' }],
      resolve: () => {},
      cancel: () => {},
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops a shared agent process once every session on it has been idle past the timeout — one kill per group', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(IDLE_MS, client)
    const first = await makeIdleSession(svc)
    const second = await makeIdleSession(svc)
    expect(first.sessionIdOnAgent.get()).not.toBe(second.sessionIdOnAgent.get())
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(IDLE_MS + 60_000)
    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(killSpy).toHaveBeenCalledWith('fake', '/w', undefined)
    svc.dispose()
  })

  it('does not reclaim a group while one of its sessions is running', async () => {
    const client = new FakeAcpClientService({ stubOptions: { promptControl: true } })
    const svc = makeService(IDLE_MS, client)
    const idle = await svc.createSession('fake', { cwd: '/w' })
    const busy = await svc.createSession('fake', { cwd: '/w' })
    if (!(idle instanceof AcpSession) || !(busy instanceof AcpSession)) {
      throw new Error('expected concrete AcpSession instances')
    }
    await idle.whenConnected()
    await busy.whenConnected()
    void idle.sendPrompt('settles')
    void busy.sendPrompt('hangs')
    await vi.advanceTimersByTimeAsync(10)
    client.connected[0]!.agent.promptDeferreds[0]!.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(idle.status.get()).toBe('idle')
    expect(busy.status.get()).toBe('running')
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(3 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('does not reclaim while a permission decision is pending', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(IDLE_MS, client)
    const session = await makeIdleSession(svc)
    session.presentPermission(pendingPermission())
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(3 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('does not reclaim while background tasks are still running', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(IDLE_MS, client)
    const session = await makeIdleSession(svc)
    // Background tasks outlive the settled turn, so the session reads as idle —
    // killing the process would kill real work going on agent-side.
    session.applyBackgroundActivity({ backgroundTasks: 1, autonomousTurn: false })
    expect(session.status.get()).toBe('idle')
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(3 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('never reclaims when the timeout is disabled (0)', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(0, client)
    await makeIdleSession(svc)
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(10 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('does not reclaim an all-closed group (left to the pool grace eviction)', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(IDLE_MS, client)
    const session = await makeIdleSession(svc)
    await session.close()
    expect(session.status.get()).toBe('closed')
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(3 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('does not reclaim a session that never sent a message (nothing to resume against)', async () => {
    const client = new FakeAcpClientService()
    const svc = makeService(IDLE_MS, client)
    const session = await svc.createSession('fake', { cwd: '/w' })
    if (!(session instanceof AcpSession)) throw new Error('expected a concrete AcpSession')
    await session.whenConnected()
    expect(session.status.get()).toBe('idle')
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    await vi.advanceTimersByTimeAsync(3 * IDLE_MS + 60_000)
    expect(killSpy).not.toHaveBeenCalled()
    svc.dispose()
  })

  it('does not reclaim before the timeout elapses', async () => {
    const idleMs = 90_000 // above the 60s watchdog tick so tick alignment can't flake the assertions
    const client = new FakeAcpClientService()
    const svc = makeService(idleMs, client)
    await makeIdleSession(svc)
    const killSpy = vi.spyOn(client, 'killConnectionFor')

    // One tick while still inside the idle window.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(killSpy).not.toHaveBeenCalled()

    // The first tick past the window reaps the connection.
    await vi.advanceTimersByTimeAsync(idleMs)
    expect(killSpy).toHaveBeenCalledTimes(1)
    svc.dispose()
  })
})
