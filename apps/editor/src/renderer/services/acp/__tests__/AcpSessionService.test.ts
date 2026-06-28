/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionService.ts
 *  Drives AcpSessionService with a fake AcpClientService backed by an
 *  in-memory ACP stream pair + a stub Agent implementation. We dispatch
 *  session/update notifications via the sink the service registers on
 *  connect() to exercise the streaming / tool-call / plan code paths
 *  without going through the SDK wire.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  autorun,
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
  IHostService,
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

const FAKE_HOST: IHostService = { platform: 'linux' } as IHostService
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
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
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import type { AskUserQuestionRequest } from '../acpSessionService.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import type { IAcpSessionTitleService } from '../acpSessionTitleService.js'
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
  allAgentIds(): readonly string[] {
    // Empty on purpose — these tests exercise createSession/resumeSession in
    // isolation; the protocol-hydrate sweep that consumes allAgentIds() runs
    // through its own dedicated tests with a real ACP pair.
    return []
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

function makeHistory(): AcpSessionHistoryService {
  return new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_HOST,
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
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly newSessionCalls: NewSessionRequest[] = []
  readonly loadSessionCalls: LoadSessionRequest[] = []
  readonly promptCalls: PromptRequest[] = []
  readonly cancelCalls: CancelNotification[] = []
  readonly setConfigOptionCalls: SetSessionConfigOptionRequest[] = []
  readonly extMethodCalls: Array<{ method: string; params: Record<string, unknown> }> = []
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
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: this._opts.loadSession ?? false,
        promptCapabilities: {},
        ...(this._opts.mcpCapabilities ? { mcpCapabilities: this._opts.mcpCapabilities } : {}),
      },
      authMethods: [],
    } as unknown as InitializeResponse)
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params)
    return Promise.resolve({ sessionId: this._agentSessionId } as unknown as NewSessionResponse)
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
    return Promise.resolve({ stopReason: 'end_turn' } as unknown as PromptResponse)
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
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }

  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.extMethodCalls.push({ method, params })
    return Promise.resolve({})
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
  beforeEach(() => {
    client = new FakeAcpClientService()
    notifications = new StubNotificationService()
    permission = new StubPermissionHandler()
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      { executeCommand: async () => undefined } as never,
      telemetry,
      permission,
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      FAKE_HOST,
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
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      { executeCommand: async () => undefined } as never,
      telemetry,
      permission,
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      FAKE_HOST,
    )
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('hi there')
    // Give the prompt request time to land on the agent side.
    await new Promise((r) => setTimeout(r, 10))
    expect(conn.agent.promptCalls).toHaveLength(1)
    expect(s.status.get()).toBe('running')

    await s.cancelTurn()
    await promptPromise
    expect(s.status.get()).toBe('idle')
    const msgs = s.messages.get()
    expect(msgs.at(-1)?.text).toBe('[cancelled]')
  })

  describe('concurrent steering prompts', () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

    function rebuildControlled(): void {
      svc.dispose()
      client = new FakeAcpClientService({ stubOptions: { promptControl: true } })
      svc = new AcpSessionService(
        client,
        new FakeAgentRegistry(),
        new FakeWorkspaceService(),
        new ConfigurationService(),
        notifications,
        { executeCommand: async () => undefined } as never,
        new NoopTelemetryService(),
        permission,
        new StubLoggerService(),
        makeHistory(),
        new FakeStorage(),
        makeAgentDefaults(),
        new StubConfigOptionsCache(),
        new StubSessionChangeTracker(),
        new StubSessionTitleService(),
        FAKE_HOST,
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

    it('cancelTurn interrupts all in-flight prompts with a single notification and message', async () => {
      rebuildControlled()
      const s = await svc.createSession()
      await s.whenConnected()
      const conn = client.connected[0]!
      const p1 = s.sendPrompt('one')
      const p2 = s.sendPrompt('two')
      await tick()
      expect(s.status.get()).toBe('running')

      await s.cancelTurn()
      await Promise.all([p1, p2])
      expect(conn.agent.cancelCalls).toHaveLength(1)
      const cancels = s.messages.get().filter((m) => m.text === '[cancelled]')
      expect(cancels).toHaveLength(1)
      expect(s.status.get()).toBe('idle')
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

  it('routes an AskUserQuestion to the matching session and resolves with answers', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    await a.whenConnected()
    await b.whenConnected()
    void a
    const promise = svc.onAskUserQuestion({
      sessionId: 'agent-2',
      toolCallId: 'q1',
      questions: [
        {
          question: 'Pick a color?',
          header: 'Color',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: false,
        },
      ],
    } satisfies AskUserQuestionRequest)
    await new Promise((r) => setTimeout(r, 0))
    expect(a.pendingQuestion.get()).toBeUndefined()
    const pending = b.pendingQuestion.get()
    expect(pending?.toolCallId).toBe('q1')
    expect(pending?.questions[0]?.question).toBe('Pick a color?')
    pending!.resolve({ answers: { 'Pick a color?': 'Blue' } })
    await expect(promise).resolves.toEqual({ answers: { 'Pick a color?': 'Blue' } })
    expect(b.pendingQuestion.get()).toBeUndefined()
  })

  it('returns cancelled when the AskUserQuestion card is dismissed', async () => {
    const b = await svc.createSession()
    await b.whenConnected()
    const promise = svc.onAskUserQuestion({
      sessionId: 'agent-1',
      toolCallId: 'q2',
      questions: [{ question: 'Q?', header: 'Q', options: [{ label: 'A' }] }],
    } satisfies AskUserQuestionRequest)
    await new Promise((r) => setTimeout(r, 0))
    b.pendingQuestion.get()!.cancel()
    await expect(promise).resolves.toEqual({ cancelled: true })
  })

  it('cancels a pending AskUserQuestion when the session closes', async () => {
    const b = await svc.createSession()
    await b.whenConnected()
    const promise = svc.onAskUserQuestion({
      sessionId: 'agent-1',
      toolCallId: 'q3',
      questions: [{ question: 'Q?', header: 'Q', options: [{ label: 'A' }] }],
    } satisfies AskUserQuestionRequest)
    await new Promise((r) => setTimeout(r, 0))
    expect(b.pendingQuestion.get()).toBeDefined()
    await svc.closeSession(b.id)
    await expect(promise).resolves.toEqual({ cancelled: true })
  })

  it('returns cancelled when the AskUserQuestion targets an unknown session', async () => {
    const result = await svc.onAskUserQuestion({
      sessionId: 'agent-nope',
      toolCallId: 'q4',
      questions: [{ question: 'Q?', header: 'Q', options: [{ label: 'A' }] }],
    } satisfies AskUserQuestionRequest)
    expect(result).toEqual({ cancelled: true })
  })
})

describe('AcpSessionService — startup timeout', () => {
  it('seals the session as errored when the agent never answers initialize', async () => {
    const client = new FakeAcpClientService({ stubOptions: { initializeHangs: true } })
    const config = new ConfigurationService()
    await config.update('acp.startupTimeoutMs', 50)
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      new StubNotificationService(),
      { executeCommand: async () => undefined } as never,
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      FAKE_HOST,
    )
    // createSession returns synchronously now; the handshake fails in the
    // background after the startup timeout fires, sealing the session via
    // failConnection (status → 'errored' + an '[error]' message) rather than
    // rejecting the createSession promise.
    const s = await svc.createSession()
    await s.whenConnected()
    expect(s.status.get()).toBe('errored')
    expect(s.messages.get().at(-1)?.text).toMatch(/timed out/)
    svc.dispose()
  })

  it('does not lose or hang a prompt queued before a failed connection', async () => {
    const client = new FakeAcpClientService({ stubOptions: { initializeHangs: true } })
    const config = new ConfigurationService()
    await config.update('acp.startupTimeoutMs', 50)
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      new StubNotificationService(),
      { executeCommand: async () => undefined } as never,
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      FAKE_HOST,
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
  function makeService(client: FakeAcpClientService, config: ConfigurationService) {
    return new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      new StubNotificationService(),
      { executeCommand: async () => undefined } as never,
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      FAKE_HOST,
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
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
      new StubNotificationService(),
      { executeCommand: async () => undefined } as never,
      new NoopTelemetryService() as ITelemetryService,
      new StubPermissionHandler(),
      new StubLoggerService(),
      history,
      new FakeStorage(),
      makeAgentDefaults(),
      new StubConfigOptionsCache(),
      new StubSessionChangeTracker(),
      title,
      FAKE_HOST,
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
})
