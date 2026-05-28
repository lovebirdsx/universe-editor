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
  IProgressOptions,
  IProgressService,
  IProgressStep,
  IStorageService,
  ITelemetryService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import { CancellationToken } from '@universe-editor/platform'

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
  /** When true, initialize() never resolves — used to exercise startup timeout. */
  initializeHangs?: boolean
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly newSessionCalls: NewSessionRequest[] = []
  readonly loadSessionCalls: LoadSessionRequest[] = []
  readonly promptCalls: PromptRequest[] = []
  readonly cancelCalls: CancelNotification[] = []
  readonly setConfigOptionCalls: SetSessionConfigOptionRequest[] = []

  constructor(
    private readonly _agentSessionId: string,
    private readonly _opts: StubAgentOptions = {},
  ) {}

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    if (this._opts.initializeHangs) return new Promise<never>(() => {})
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
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
}

/**
 * Captures the sink + connection so tests can inject inbound traffic.
 */
interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly agent: StubAgent
  readonly agentConn: AgentSideConnection
  readonly clientConn: ClientSideConnection
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

    const session: ConnectedSession = { sink, agent, agentConn, clientConn }
    this.connected.push(session)
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {
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
      telemetry,
      permission,
      new StubProgressService(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      FAKE_HOST,
    )
  })

  afterEach(() => {
    svc.dispose()
  })

  it('createSession spawns a connection and appends to sessions / sets active', async () => {
    const session = await svc.createSession()
    expect(session.agentId).toBe('fake')
    expect(svc.sessions.get()).toHaveLength(1)
    expect(svc.activeSession.get()?.id).toBe(session.id)
    expect(svc.activeSessionId.get()).toBe(session.id)
  })

  it('setActive switches the active session', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    expect(svc.activeSession.get()?.id).toBe(b.id)
    svc.setActive(a.id)
    expect(svc.activeSession.get()?.id).toBe(a.id)
    expect(svc.activeSessionId.get()).toBe(a.id)
  })

  it('routes session/update notifications to the matching session by agentSessionId', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
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
      { content: 'step one', priority: 'high' },
      { content: 'step two', priority: 'medium' },
    ])
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
      telemetry,
      permission,
      new StubProgressService(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      FAKE_HOST,
    )
    const s = await svc.createSession()
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

  it('auto-approves a permission request when the kind is on the allow list', async () => {
    const s = await svc.createSession()
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
})

describe('AcpSessionService — startup timeout', () => {
  it('rejects createSession when the agent never answers initialize', async () => {
    const client = new FakeAcpClientService({ stubOptions: { initializeHangs: true } })
    const config = new ConfigurationService()
    await config.update('acp.startupTimeoutMs', 50)
    const svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      new StubNotificationService(),
      new NoopTelemetryService(),
      new StubPermissionHandler(),
      new StubProgressService(),
      new StubLoggerService(),
      makeHistory(),
      new FakeStorage(),
      makeAgentDefaults(),
      FAKE_HOST,
    )
    await expect(svc.createSession()).rejects.toThrow(/timed out/)
    svc.dispose()
  })
})
