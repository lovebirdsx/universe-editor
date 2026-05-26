/*---------------------------------------------------------------------------------------------
 *  Stage 10 tests for AcpSessionService — resumeSession path. The fake ACP
 *  client wires an in-memory ACP stream pair to a stub Agent so each test can
 *  seed `initialize` and `session/load` behaviour and verify:
 *    - happy path (initialize advertises loadSession=true → session/load applies state)
 *    - capability gate (initialize does not advertise loadSession → reject)
 *    - unknown history id (no agent spawned)
 *    - existing live session reuse (no agent spawned)
 *    - session/load failure → full rollback (no leaked session, conn disposed)
 *    - history.touch on createSession success + on every sendPrompt
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
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
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { AcpSessionService } from '../acpSessionService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { createInMemoryAcpPair } from '../testing/inMemoryAcpPair.js'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

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
  fireWorkspaceScopeChange(): void {
    this._onDidChangeWorkspaceScope.fire()
  }
}

// ---------------------------------------------------------------------------
// Parameterized stub agent + fake AcpClient
// ---------------------------------------------------------------------------

interface FakeAcpClientOptions {
  /** Replace the default initialize result. Default advertises loadSession=true. */
  initializeResult?: Partial<InitializeResponse>
  /** Per-call override for session/load result (default: empty object). */
  loadSessionResult?: Partial<LoadSessionResponse>
  /** Throw an RPC error from session/load instead of returning a result. */
  loadSessionError?: { code: number; message: string }
  /** Trigger session/update notifications BEFORE session/load resolves. */
  loadSessionUpdates?: readonly SessionNotification[]
  /** Result for session/set_config_option. Default: `{ configOptions: [] }`. */
  setConfigOptionResult?: { configOptions: readonly SessionConfigOption[] }
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly newSessionCalls: NewSessionRequest[] = []
  readonly loadSessionCalls: LoadSessionRequest[] = []
  readonly promptCalls: PromptRequest[] = []
  readonly cancelCalls: CancelNotification[] = []
  readonly setConfigOptionCalls: SetSessionConfigOptionRequest[] = []
  /** Set by the fake client right after construction so the agent can stream updates. */
  connection?: AgentSideConnection

  constructor(
    private readonly _agentSessionId: string,
    private readonly _opts: FakeAcpClientOptions,
  ) {}

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: {} },
      authMethods: [],
      ...(this._opts.initializeResult ?? {}),
    } as unknown as InitializeResponse)
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCalls.push(params)
    return Promise.resolve({ sessionId: this._agentSessionId } as unknown as NewSessionResponse)
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(params)
    // Stream any pre-load notifications first to verify the routing path.
    if (this.connection) {
      for (const upd of this._opts.loadSessionUpdates ?? []) {
        await this.connection.sessionUpdate(upd)
      }
    }
    if (this._opts.loadSessionError) {
      throw new RequestError(this._opts.loadSessionError.code, this._opts.loadSessionError.message)
    }
    return (this._opts.loadSessionResult ?? {}) as unknown as LoadSessionResponse
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(params)
    // Never resolves — exercises sendPrompt without us having to manage it.
    return new Promise<never>(() => {})
  }

  cancel(params: CancelNotification): Promise<void> {
    this.cancelCalls.push(params)
    return Promise.resolve()
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.setConfigOptionCalls.push(params)
    return Promise.resolve(
      (this._opts.setConfigOptionResult ?? { configOptions: [] }) as SetSessionConfigOptionResponse,
    )
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly agent: StubAgent
  readonly clientConn: ClientSideConnection
  readonly pair: ReturnType<typeof createInMemoryAcpPair>
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  readonly connectArgs: { agentId: string; cwd: string | undefined }[] = []
  private _agentSeq = 0
  private _sink: IAcpClientNotificationSink | undefined

  constructor(private readonly _opts: FakeAcpClientOptions = {}) {}

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  drainAll(): void {}

  /**
   * Simulate "connection closed without going through session.close()" —
   * e.g. pool grace expiry, agent crash, drainAll. Closes both writable
   * sides of the in-memory pair so the SDK detects EOF and aborts the
   * ClientSideConnection's signal, which fires AcpSession's onClose listener.
   */
  async simulateConnectionAbort(idx: number): Promise<void> {
    const entry = this.connected[idx]
    if (!entry) throw new Error(`no connection at ${idx}`)
    await entry.pair.clientStream.writable.close().catch(() => {})
    await entry.pair.agentStream.writable.close().catch(() => {})
    // Let the SDK read loops see EOF and abort their signals.
    const deadline = Date.now() + 500
    while (!entry.clientConn.signal.aborted) {
      if (Date.now() > deadline) throw new Error('connection signal did not abort in time')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  async connect(
    agentId: string,
    options?: { cwd?: string; leaseFor?: string },
  ): Promise<IAcpClientConnection> {
    const sink = this._sink
    if (!sink) throw new Error('FakeAcpClientService.connect: sink not installed')
    this.connectArgs.push({ agentId, cwd: options?.cwd })
    const agentSessionId = `agent-${++this._agentSeq}`
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(agentSessionId, this._opts)
    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    agent.connection = agentConn
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
    this.connected.push({ sink, agent, clientConn, pair })
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {
        void pair.clientStream.writable.close().catch(() => {})
        void pair.agentStream.writable.close().catch(() => {})
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: build a service with a freshly-instantiated history service.
// ---------------------------------------------------------------------------

function buildService(opts: FakeAcpClientOptions = {}): {
  svc: AcpSessionService
  client: FakeAcpClientService
  history: AcpSessionHistoryService
  agentDefaults: AcpAgentDefaultsService
  notifications: StubNotificationService
  storage: FakeStorage
} {
  const client = new FakeAcpClientService(opts)
  const config: IConfigurationService = new ConfigurationService()
  const telemetry: ITelemetryService = new NoopTelemetryService()
  const notifications = new StubNotificationService()
  const storage = new FakeStorage()
  const history = new AcpSessionHistoryService(
    storage,
    new FakeWorkspaceService(),
    telemetry,
    new StubLoggerService(),
    FAKE_HOST,
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
    notifications,
    telemetry,
    new StubPermissionHandler(),
    new StubProgressService(),
    new StubLoggerService(),
    history,
    storage,
    agentDefaults,
    FAKE_HOST,
  )
  return { svc, client, history, agentDefaults, notifications, storage }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSessionService — historyId routing (editor restart)', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('uses sessionIdOnAgent as both AcpSession.id and the history entry id', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const session = await svc.createSession()
    const entryId = built.history.list()[0]?.id
    expect(entryId).toBeDefined()
    expect(session.id).toBe(entryId)
  })

  it('getById returns the live session by its sessionId', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const a = await svc.createSession()
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.createSession()
    expect(svc.getById(a.id)?.id).toBe(a.id)
    expect(svc.getById(b.id)?.id).toBe(b.id)
  })

  it('getById returns undefined when no live session matches', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    expect(svc.getById('nope')).toBeUndefined()
  })

  it('resumeSession yields a session whose id matches the resumed entry', async () => {
    const built = buildService({ loadSessionResult: {} })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const sessionId = original.id
    await svc.closeSession(original.id)
    const resumed = await svc.resumeSession(sessionId)
    expect(resumed.id).toBe(sessionId)
    expect(svc.getById(sessionId)?.id).toBe(resumed.id)
  })
})

describe('AcpSessionService — history wiring', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('createSession records the new session in history with cwd', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const session = await svc.createSession()
    const entries = built.history.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.agentId).toBe('fake')
    expect(entries[0]?.sessionIdOnAgent).toBe('agent-1')
    expect(entries[0]?.title).toBe(session.title)
    // FakeWorkspaceService has no folder open, so cwd should be absent.
    expect('cwd' in (entries[0] ?? {})).toBe(false)
  })

  it('sendPrompt bumps the history entry to the head of the LRU', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const a = await svc.createSession()
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.createSession()
    expect(built.history.list().map((e) => e.sessionIdOnAgent)).toEqual([b.id, a.id])
    await new Promise((r) => setTimeout(r, 5))
    // Bumping `a` via sendPrompt: history.touch() runs synchronously at the
    // start of sendPrompt. We cancel the never-resolving prompt afterwards.
    // Note: sendPrompt also derives the title from the first prompt — so we
    // assert by id (stable) rather than by title.
    void a.sendPrompt('hi')
    expect(built.history.list().map((e) => e.sessionIdOnAgent)).toEqual([a.id, b.id])
    await a.cancelTurn()
  })
})

describe('AcpSessionService.resumeSession — happy path', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('rejects on unknown historyId without spawning an agent', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    await expect(svc.resumeSession('bogus')).rejects.toThrow(/Unknown agent session id/)
    expect(built.client.connected).toHaveLength(0)
  })

  it('reuses an already-live session if its sessionIdOnAgent matches', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    expect(built.client.connected).toHaveLength(1)
    svc.setActive(original.id)
    const resumed = await svc.resumeSession(historyId)
    expect(resumed.id).toBe(original.id)
    expect(built.client.connected).toHaveLength(1)
    expect(svc.activeSession.get()?.id).toBe(original.id)
  })

  it('spawns a fresh agent and applies session/load state when capability=true', async () => {
    const configFixture: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    }
    const built = buildService({
      loadSessionResult: { configOptions: [configFixture] },
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)
    expect(svc.sessions.get()).toHaveLength(0)

    const resumed = await svc.resumeSession(historyId)
    expect(resumed.agentId).toBe('fake')
    expect(svc.sessions.get()).toHaveLength(1)
    expect(svc.activeSession.get()?.id).toBe(resumed.id)
    const opts = resumed.configOptions.get()
    expect(opts.find((o) => o.id === 'model')?.currentValue).toBe('opus')
    // The resumed agent is the SECOND connection created by the fake client.
    expect(built.client.connected[1]?.agent.loadSessionCalls).toHaveLength(1)
  })

  it('tolerates an empty session/load result (no state to apply)', async () => {
    const built = buildService({ loadSessionResult: {} })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)
    const resumed = await svc.resumeSession(historyId)
    expect(resumed.configOptions.get()).toEqual([])
  })

  it('routes session/update notifications streamed DURING session/load to the resumed session', async () => {
    const built = buildService({
      loadSessionUpdates: [
        {
          // The resumed session keeps its original sessionIdOnAgent ('agent-1'),
          // NOT the fake-client's internal _agentSeq counter — session/load is
          // explicitly designed to revive an existing id.
          sessionId: 'agent-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed history' },
          },
        },
      ],
      loadSessionResult: {},
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)
    const resumed = await svc.resumeSession(historyId)
    const msgs = resumed.messages.get()
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.text).toBe('replayed history')
  })
})

describe('AcpSessionService.resumeSession — failure paths', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('rejects when the agent does not advertise loadSession capability', async () => {
    const built = buildService({
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
      } as Partial<InitializeResponse>,
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)

    await expect(svc.resumeSession(historyId)).rejects.toThrow(/does not advertise.*loadSession/)
    expect(svc.sessions.get()).toHaveLength(0)
    expect(built.notifications.captured.length).toBe(1)
  })

  it('rolls back to no session when session/load fails (and the partial entry is disposed)', async () => {
    const built = buildService({
      loadSessionError: { code: -32603, message: 'agent went sideways' },
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)

    await expect(svc.resumeSession(historyId)).rejects.toThrow(/agent went sideways/)
    expect(svc.sessions.get()).toHaveLength(0)
    expect(svc.activeSession.get()).toBeUndefined()
    expect(built.notifications.captured.length).toBe(1)
    expect(built.notifications.captured[0]?.message).toMatch(/Failed to resume/)
  })

  it('replaces a same-id session that closed without going through closeSession', async () => {
    // The connection-pool grace timer, drainAll(), and agent crashes all flip
    // a live AcpSession to status='closed' WITHOUT removing it from _sessions
    // (the onClose listener in acpSession.ts is the only handler). resumeSession
    // must purge the stale instance before appending the new one, otherwise
    // _sessions ends up with two entries for the same id — find()-based routing
    // hits the stale one and replayed messages either duplicate (editor mode,
    // reads via getById) or vanish (sidebar mode, reads via activeSession).
    const built = buildService({
      loadSessionUpdates: [
        {
          sessionId: 'agent-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed' },
          },
        },
      ],
      loadSessionResult: {},
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await built.client.simulateConnectionAbort(0)
    expect(original.status.get()).toBe('closed')
    expect(svc.sessions.get()).toHaveLength(1)

    const resumed = await svc.resumeSession(historyId)
    expect(resumed).not.toBe(original)
    expect(svc.sessions.get()).toHaveLength(1)
    expect(svc.getById(historyId)).toBe(resumed)
    expect(svc.activeSession.get()).toBe(resumed)
    expect(resumed.messages.get().map((m) => m.text)).toEqual(['replayed'])
    expect(original.messages.get()).toEqual([])
  })
})

describe('AcpSessionService.resumeSession — editor-restart race', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  /**
   * Repro for the "tab shows GUID with Resuming agent session… stuck forever"
   * bug seen after editor restart. The renderer restores `AcpSessionEditorInput`
   * synchronously at BlockRestore, then React mounts and `AcpSessionEditor`'s
   * `useEffect` calls `service.resumeSession(sessionId)` BEFORE the
   * fire-and-forget `acpSessionHistoryService.initialize()` from main.tsx
   * resolves. `_resumeSessionInner` synchronously reads `history.get(sessionId)`
   * → undefined → throws "Unknown agent session id". The notification fires
   * once, then the spinner stays forever because `resumeAttempted` is set.
   *
   * resumeSession must wait for history hydration before treating a missing
   * entry as a real "unknown id".
   */
  it('awaits history hydration before treating a missing entry as unknown', async () => {
    // Round 1: prime storage with a session entry.
    const round1 = buildService({ loadSessionResult: {} })
    await round1.history.initialize()
    const original = await round1.svc.createSession()
    const sessionId = original.id
    await flushHistoryWrite()
    round1.svc.dispose()

    // Round 2: simulate editor restart. Build a fresh history+service and
    // call resumeSession WITHOUT awaiting history.initialize() — this mirrors
    // the real bootstrap order where AcpSessionEditor fires resumeSession in
    // useEffect before main.tsx's `void historyService.initialize()` resolves.
    const storage = round1.storage
    const client = new FakeAcpClientService({ loadSessionResult: {} })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const notifications = new StubNotificationService()
    const history = new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      telemetry,
      new StubLoggerService(),
      FAKE_HOST,
    )
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      new StubPermissionHandler(),
      new StubProgressService(),
      new StubLoggerService(),
      history,
      storage,
      new AcpAgentDefaultsService(
        new FakeStorage(),
        new FakeWorkspaceService(),
        telemetry,
        new StubLoggerService(),
      ),
      FAKE_HOST,
    )
    // Kick off history hydration but DO NOT await — race the resume call.
    void history.initialize()

    const resumed = await svc.resumeSession(sessionId)
    expect(resumed.id).toBe(sessionId)
    expect(svc.getById(sessionId)?.id).toBe(sessionId)
    expect(client.connected[0]?.agent.loadSessionCalls).toHaveLength(1)
    // No spurious "Failed to resume" notification should have fired.
    expect(notifications.captured.filter((n) => /Failed to resume/.test(n.message))).toEqual([])
  })

  it('still rejects for a genuinely unknown id after history finished loading', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    await expect(svc.resumeSession('definitely-not-a-real-id')).rejects.toThrow(
      /Unknown agent session id/,
    )
    expect(built.client.connected).toHaveLength(0)
  })
})

const ACP_ACTIVE_SESSION_STORAGE_KEY = 'acp.activeSessionId'

/** Drain history-service's 100ms write debounce + the async set() microtask. */
async function flushHistoryWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpSessionService.tryRestoreActiveSession', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('persists the active session historyId to workspace storage on activation', async () => {
    const built = buildService({ loadSessionResult: {} })
    svc = built.svc
    await built.history.initialize()
    const session = await svc.createSession()
    // The persistence autorun runs synchronously after activeSession changes,
    // but FakeStorage.set is async — give it a microtask to land.
    await Promise.resolve()
    expect(built.storage.store.get(ACP_ACTIVE_SESSION_STORAGE_KEY)).toBe(session.id)
  })

  it('clears workspace storage when the last session closes', async () => {
    const built = buildService({ loadSessionResult: {} })
    svc = built.svc
    await built.history.initialize()
    const session = await svc.createSession()
    await Promise.resolve()
    expect(built.storage.store.has(ACP_ACTIVE_SESSION_STORAGE_KEY)).toBe(true)
    await svc.closeSession(session.id)
    await Promise.resolve()
    expect(built.storage.store.has(ACP_ACTIVE_SESSION_STORAGE_KEY)).toBe(false)
  })

  it('resumes the persisted session on startup when none is active', async () => {
    // Round 1: create a session, capture sessionId + persisted entry.
    const round1 = buildService({ loadSessionResult: {} })
    await round1.history.initialize()
    const original = await round1.svc.createSession()
    const sessionId = original.id
    await Promise.resolve()
    expect(round1.storage.store.get(ACP_ACTIVE_SESSION_STORAGE_KEY)).toBe(sessionId)
    await flushHistoryWrite()
    round1.svc.dispose()

    // Round 2: simulate editor restart by reusing the same FakeStorage instance
    // (history entry + pending-restore key carry over).
    const client = new FakeAcpClientService({ loadSessionResult: {} })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const notifications = new StubNotificationService()
    const history = new AcpSessionHistoryService(
      round1.storage,
      new FakeWorkspaceService(),
      telemetry,
      new StubLoggerService(),
      FAKE_HOST,
    )
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      new StubPermissionHandler(),
      new StubProgressService(),
      new StubLoggerService(),
      history,
      round1.storage,
      new AcpAgentDefaultsService(
        new FakeStorage(),
        new FakeWorkspaceService(),
        telemetry,
        new StubLoggerService(),
      ),
      FAKE_HOST,
    )
    expect(svc.activeSession.get()).toBeUndefined()
    await svc.tryRestoreActiveSession()
    expect(svc.activeSession.get()).toBeDefined()
    expect(svc.activeSession.get()?.id).toBe(sessionId)
    expect(client.connected[0]?.agent.loadSessionCalls).toHaveLength(1)
  })

  it('is a noop when a session is already active and drops the pending restore', async () => {
    const round1 = buildService({ loadSessionResult: {} })
    await round1.history.initialize()
    await round1.svc.createSession()
    await Promise.resolve()
    const storage = round1.storage
    const persistedHistoryId = storage.store.get(ACP_ACTIVE_SESSION_STORAGE_KEY)
    expect(persistedHistoryId).toBeDefined()
    round1.svc.dispose()

    const client = new FakeAcpClientService({ loadSessionResult: {} })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      telemetry,
      new StubLoggerService(),
      FAKE_HOST,
    )
    svc = new AcpSessionService(
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
      storage,
      new AcpAgentDefaultsService(
        new FakeStorage(),
        new FakeWorkspaceService(),
        telemetry,
        new StubLoggerService(),
      ),
      FAKE_HOST,
    )
    // Let _loadPendingRestore() resolve.
    await Promise.resolve()
    // Pre-empt the pending restore by creating a fresh session ourselves.
    await svc.createSession()
    const preCount = client.connected.length
    await svc.tryRestoreActiveSession()
    expect(client.connected.length).toBe(preCount)
  })

  it('silently no-ops when the persisted historyId is gone from history', async () => {
    const storage = new FakeStorage()
    void storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'nonexistent-history-id')
    const client = new FakeAcpClientService({ loadSessionResult: {} })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const notifications = new StubNotificationService()
    const history = new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      telemetry,
      new StubLoggerService(),
      FAKE_HOST,
    )
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      config,
      notifications,
      telemetry,
      new StubPermissionHandler(),
      new StubProgressService(),
      new StubLoggerService(),
      history,
      storage,
      new AcpAgentDefaultsService(
        new FakeStorage(),
        new FakeWorkspaceService(),
        telemetry,
        new StubLoggerService(),
      ),
      FAKE_HOST,
    )
    await Promise.resolve()
    await svc.tryRestoreActiveSession()
    expect(svc.activeSession.get()).toBeUndefined()
    expect(client.connected.length).toBe(0)
  })

  it('claims pending exactly once across concurrent invocations', async () => {
    const round1 = buildService({ loadSessionResult: {} })
    await round1.history.initialize()
    await round1.svc.createSession()
    await Promise.resolve()
    const storage = round1.storage
    await flushHistoryWrite()
    round1.svc.dispose()

    const client = new FakeAcpClientService({ loadSessionResult: {} })
    const config: IConfigurationService = new ConfigurationService()
    const telemetry: ITelemetryService = new NoopTelemetryService()
    const history = new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      telemetry,
      new StubLoggerService(),
      FAKE_HOST,
    )
    svc = new AcpSessionService(
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
      storage,
      new AcpAgentDefaultsService(
        new FakeStorage(),
        new FakeWorkspaceService(),
        telemetry,
        new StubLoggerService(),
      ),
      FAKE_HOST,
    )
    await Promise.resolve()
    await Promise.all([svc.tryRestoreActiveSession(), svc.tryRestoreActiveSession()])
    expect(client.connected.length).toBe(1)
  })
})

describe('AcpSessionService.resumeSession — configOption push-back', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  /**
   * Sets up: per-session history caches `model=opus`; agent's `session/load`
   * advertises currentValue='sonnet' for the same id. On resume the service
   * should schedule a push-back that sends `setSessionConfigOption(model, opus)`
   * to the agent, and apply the agent's ACK back into the session.
   */
  it('pushes cached per-session configOptions back to the agent on resume', async () => {
    const loadFixture: SessionConfigOption = {
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
    const acked: SessionConfigOption = { ...loadFixture, currentValue: 'opus' }
    const built = buildService({
      loadSessionResult: { configOptions: [loadFixture] },
      setConfigOptionResult: { configOptions: [acked] },
    })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()

    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    // Cache the per-session preference directly on the history entry.
    built.history.setHistoryConfigOption(historyId, 'model', 'opus')
    await svc.closeSession(original.id)

    const resumed = await svc.resumeSession(historyId)
    // The push-back is microtask-scheduled and itself awaits a wire RPC; give
    // it a couple cycles to settle.
    await new Promise((r) => setTimeout(r, 30))

    const resumeAgent = built.client.connected[1]!.agent
    expect(resumeAgent.setConfigOptionCalls).toHaveLength(1)
    expect(resumeAgent.setConfigOptionCalls[0]).toMatchObject({
      configId: 'model',
      value: 'opus',
    })
    expect(resumed.configOptions.get().find((o) => o.id === 'model')?.currentValue).toBe('opus')
  })

  it('per-session history overrides per-agent default when both are cached', async () => {
    const loadFixture: SessionConfigOption = {
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
    const acked: SessionConfigOption = { ...loadFixture, currentValue: 'haiku' }
    const built = buildService({
      loadSessionResult: { configOptions: [loadFixture] },
      setConfigOptionResult: { configOptions: [acked] },
    })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()

    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    // Per-agent default says 'opus'. Per-session history says 'haiku'.
    // The session-specific choice MUST win — a user who explicitly chose
    // 'haiku' for THIS session doesn't want the global default to override.
    built.agentDefaults.setDefault('fake', 'model', 'opus')
    built.history.setHistoryConfigOption(historyId, 'model', 'haiku')
    await svc.closeSession(original.id)

    await svc.resumeSession(historyId)
    await new Promise((r) => setTimeout(r, 30))

    const resumeAgent = built.client.connected[1]!.agent
    expect(resumeAgent.setConfigOptionCalls).toHaveLength(1)
    expect(resumeAgent.setConfigOptionCalls[0]?.value).toBe('haiku')
  })

  it('falls back to per-agent default when per-session history has no cache for the id', async () => {
    const loadFixture: SessionConfigOption = {
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
    const acked: SessionConfigOption = { ...loadFixture, currentValue: 'opus' }
    const built = buildService({
      loadSessionResult: { configOptions: [loadFixture] },
      setConfigOptionResult: { configOptions: [acked] },
    })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()

    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    // No per-session override — only the global default.
    built.agentDefaults.setDefault('fake', 'model', 'opus')
    await svc.closeSession(original.id)

    await svc.resumeSession(historyId)
    await new Promise((r) => setTimeout(r, 30))

    const resumeAgent = built.client.connected[1]!.agent
    expect(resumeAgent.setConfigOptionCalls).toHaveLength(1)
    expect(resumeAgent.setConfigOptionCalls[0]?.value).toBe('opus')
  })

  it('skips push-back when the cached value already matches the agent state', async () => {
    const loadFixture: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    }
    const built = buildService({ loadSessionResult: { configOptions: [loadFixture] } })
    svc = built.svc
    await built.history.initialize()
    await built.agentDefaults.initialize()

    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    built.history.setHistoryConfigOption(historyId, 'model', 'opus')
    await svc.closeSession(original.id)

    await svc.resumeSession(historyId)
    await new Promise((r) => setTimeout(r, 30))

    const resumeAgent = built.client.connected[1]!.agent
    expect(resumeAgent.setConfigOptionCalls).toHaveLength(0)
  })
})
