/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionRestoreCoordinator.ts
 *
 *  The coordinator's job is to:
 *    1) on construction-time `start()`, read `acp.activeSessionHistoryId` from
 *       WORKSPACE storage (hydrate is NOT auto-fired — it must be requested
 *       lazily once the user reveals the Agents view, see `requestHydrate()`)
 *    2) on `requestHydrate()`, run the cross-agent `session/list` sweep once
 *       per cwd; idempotent within the same workspace; deferred until
 *       `whenWorkspaceReady` resolves so the cwd is known
 *    3) on `tryRestoreActiveSession()`, call back into the facade's
 *       resumeSession exactly once for the pending id (and only if no live
 *       session has already taken its place)
 *    4) on `onWorkspaceSwap()`, repeat the pending-restore load against the
 *       new bucket and reset the hydrate gate so the next `requestHydrate()`
 *       re-sweeps with the new cwd
 *    5) on `deleteOnAgent()`, gate the protocol call on the agent's advertised
 *       sessionCapabilities.delete and translate the RPC result to a coarse
 *       'ok' / 'unsupported' / 'unknown' / 'error' tag for the facade
 *
 *  Tests use a stub Agent over the real `inMemoryAcpPair` so capability
 *  advertisement, list pagination, and delete failures all flow through the
 *  real SDK wire — guarding against schema drift.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
  Severity,
  StorageScope,
  UriIdentityService,
} from '@universe-editor/platform'
import type {
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IStorageService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type DeleteSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import {
  ACP_ACTIVE_SESSION_STORAGE_KEY,
  AcpSessionRestoreCoordinator,
  type RestoreCoordinatorCallbacks,
} from '../acpSessionRestoreCoordinator.js'
import {
  type IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import { AcpSessionHistoryService, type SessionHistoryScope } from '../acpSessionHistory.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import { createInMemoryAcpPair } from '../testing/inMemoryAcpPair.js'
import type { IAcpSession } from '../acpSession.js'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')

// ---------------------------------------------------------------------------
// Stubs (kept close to existing patterns in this folder)
// ---------------------------------------------------------------------------

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly current: IWorkspace | null = null
  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event
  readonly recent: readonly never[] = []
  private readonly _onDidChangeRecent = new Emitter<readonly never[]>()
  readonly onDidChangeRecent = this._onDidChangeRecent.event
  readonly whenReady: Promise<void> = Promise.resolve()
  async openFolder(): Promise<void> {}
  async closeFolder(): Promise<void> {}
  async clearRecent(): Promise<void> {}
  async removeRecent(): Promise<void> {}
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

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  readScope: StorageScope | undefined
  readonly getCalls: { key: string; scope: StorageScope | undefined }[] = []
  constructor() {
    queueMicrotask(() => this._onDidChangeWorkspaceScope.fire())
  }
  async get<T = unknown>(key: string, scope?: StorageScope): Promise<T | undefined> {
    this.readScope = scope
    this.getCalls.push({ key, scope })
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

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  constructor(private readonly _ids: readonly string[] = ['fake']) {}
  list() {
    return this._ids.map((id) => ({ id, name: id, command: '/x', args: [] }))
  }
  allAgentIds(): readonly string[] {
    return this._ids
  }
  get(agentId: string) {
    return this.list().find((a) => a.id === agentId)!
  }
  resolve(agentId: string) {
    const a = this.get(agentId)
    return { command: a.command, args: a.args }
  }
  defaultAgentId(): string {
    return this._ids[0] ?? 'fake'
  }
  readonly defaultAgentIdObs = observableValue<string>('fake.defaultAgentId', 'fake')
  setDefaultAgentId(_agentId: string): void {}
  async health(): Promise<{ available: boolean }> {
    return { available: true }
  }
}

// ---------------------------------------------------------------------------
// Stub Agent + IAcpClientService backed by the real SDK + in-memory pair
// ---------------------------------------------------------------------------

interface StubAgentOptions {
  /** Override agentCapabilities returned from `initialize`. */
  readonly capabilities?: AgentCapabilities
  /** Per-page session list (last page returns nextCursor=null). */
  readonly listPages?: readonly (readonly SessionInfo[])[]
  /** Throw an error from listSessions. */
  readonly listError?: { code: number; message: string }
  /** Throw an error from initialize. */
  readonly initializeError?: { code: number; message: string }
  /** Throw an error from unstable_deleteSession. */
  readonly deleteError?: { code: number; message: string }
}

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []
  readonly listCalls: ListSessionsRequest[] = []
  readonly deleteCalls: DeleteSessionRequest[] = []
  connection?: AgentSideConnection

  constructor(private readonly _opts: StubAgentOptions) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    if (this._opts.initializeError) {
      throw new RequestError(this._opts.initializeError.code, this._opts.initializeError.message)
    }
    return {
      protocolVersion: 1,
      agentCapabilities: this._opts.capabilities ?? {},
      authMethods: [],
    } as unknown as InitializeResponse
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.listCalls.push(params)
    if (this._opts.listError) {
      throw new RequestError(this._opts.listError.code, this._opts.listError.message)
    }
    const pages = this._opts.listPages ?? []
    // Cursors are zero-based page indices encoded as strings.
    const cursor = params.cursor == null ? 0 : Number(params.cursor)
    const page = pages[cursor] ?? []
    const isLast = cursor + 1 >= pages.length
    return {
      sessions: [...page],
      nextCursor: isLast ? null : String(cursor + 1),
    } as unknown as ListSessionsResponse
  }

  async unstable_deleteSession(params: DeleteSessionRequest): Promise<void> {
    this.deleteCalls.push(params)
    if (this._opts.deleteError) {
      throw new RequestError(this._opts.deleteError.code, this._opts.deleteError.message)
    }
  }

  newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    throw new Error('not used in coordinator tests')
  }
  loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    throw new Error('not used in coordinator tests')
  }
  prompt(_params: PromptRequest): Promise<PromptResponse> {
    throw new Error('not used in coordinator tests')
  }
  cancel(_params: CancelNotification): Promise<void> {
    return Promise.resolve()
  }
  setSessionConfigOption(
    _params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    throw new Error('not used in coordinator tests')
  }
  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connectCalls: {
    agentId: string
    cwd: string | undefined
    silent: boolean | undefined
  }[] = []
  /** disposed-ness per agent connection — index matches connectCalls. */
  readonly disposed: boolean[] = []
  readonly agents: StubAgent[] = []
  /** connect() can reject for an agent id to model spawn failures. */
  rejectAgents = new Set<string>()
  /** Map per-agent options, falling back to default StubAgent behaviour. */
  agentOptions = new Map<string, StubAgentOptions>()
  private _sink: IAcpClientNotificationSink | undefined

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  drainAll(): void {}
  killConnectionFor(): void {}

  async connect(
    agentId: string,
    options?: { cwd?: string; leaseFor?: string; silent?: boolean },
  ): Promise<IAcpClientConnection> {
    const sink: IAcpClientNotificationSink = this._sink ?? {
      onSessionUpdate: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) as never,
      onAskUserQuestion: async () => ({ cancelled: true }),
    }
    this.connectCalls.push({ agentId, cwd: options?.cwd, silent: options?.silent })
    if (this.rejectAgents.has(agentId)) {
      throw new Error(`spawn failed for ${agentId}`)
    }
    const opts = this.agentOptions.get(agentId) ?? {}
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(opts)
    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    agent.connection = agentConn
    this.agents.push(agent)
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
    const index = this.disposed.length
    this.disposed.push(false)
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {
        this.disposed[index] = true
        void pair.clientStream.writable.close().catch(() => {})
        void pair.agentStream.writable.close().catch(() => {})
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildOptions {
  readonly agentIds?: readonly string[]
  readonly cwd?: string
  readonly hasActiveSession?: () => boolean
  readonly resumeSession?: (historyId: string) => Promise<IAcpSession>
  readonly storage?: FakeStorage
  readonly history?: AcpSessionHistoryService
  /**
   * Promise resolved when the test wants `start()` to proceed with the
   * hydrate sweep. Defaults to `Promise.resolve()` so existing tests keep
   * their synchronous-ish behavior.
   */
  readonly whenWorkspaceReady?: Promise<void>
  readonly getLiveSessionIds?: () => ReadonlySet<string>
  readonly getHistoryScope?: () => SessionHistoryScope
}

interface BuildResult {
  readonly coordinator: AcpSessionRestoreCoordinator
  readonly client: FakeAcpClientService
  readonly registry: FakeAgentRegistry
  readonly history: AcpSessionHistoryService
  readonly storage: FakeStorage
  readonly notifications: StubNotificationService
  readonly callbacks: { resumeCalls: string[] }
}

function build(opts: BuildOptions = {}): BuildResult {
  const client = new FakeAcpClientService()
  const registry = new FakeAgentRegistry(opts.agentIds ?? ['fake'])
  const storage = opts.storage ?? new FakeStorage()
  const history =
    opts.history ??
    new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      FAKE_URI_IDENTITY,
    )
  const notifications = new StubNotificationService()
  const resumeCalls: string[] = []
  // Underlying resume implementation (test-provided or a no-op success).
  const userResume: (historyId: string) => Promise<IAcpSession> =
    opts.resumeSession ??
    (async (historyId: string) => ({ id: 'live', historyId }) as unknown as IAcpSession)
  // Single recording layer — guarantees one push per real resumeSession call,
  // regardless of whether the test supplied a custom implementation.
  const recordingResume = async (historyId: string): Promise<IAcpSession> => {
    resumeCalls.push(historyId)
    return userResume(historyId)
  }
  const whenWorkspaceReady = opts.whenWorkspaceReady ?? Promise.resolve()
  const callbacks: RestoreCoordinatorCallbacks = {
    resumeSession: recordingResume,
    hasActiveSession: opts.hasActiveSession ?? (() => false),
    getCurrentCwd: () => opts.cwd,
    whenWorkspaceReady: () => whenWorkspaceReady,
    getLiveSessionIds: opts.getLiveSessionIds ?? (() => new Set<string>()),
    getHistoryScope: opts.getHistoryScope ?? (() => 'workspace'),
  }
  const coordinator = new AcpSessionRestoreCoordinator(
    client,
    registry,
    history,
    storage,
    notifications,
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_URI_IDENTITY,
    callbacks,
  )
  return {
    coordinator,
    client,
    registry,
    history,
    storage,
    notifications,
    callbacks: { resumeCalls },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSessionRestoreCoordinator — pending restore load', () => {
  let coordinator: AcpSessionRestoreCoordinator | undefined

  afterEach(() => {
    coordinator?.dispose()
    coordinator = undefined
  })

  it('reads acp.activeSessionHistoryId from WORKSPACE scope on start', async () => {
    const storage = new FakeStorage()
    await storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'h-abc')
    const built = build({ storage, agentIds: [] })
    coordinator = built.coordinator
    coordinator.start()
    await coordinator.tryRestoreActiveSession()
    // The key was read with WORKSPACE scope.
    const hit = storage.getCalls.find((c) => c.key === ACP_ACTIVE_SESSION_STORAGE_KEY)
    expect(hit?.scope).toBe(StorageScope.WORKSPACE)
    expect(built.callbacks.resumeCalls).toEqual(['h-abc'])
  })

  it('does nothing when no pending restore id is stored', async () => {
    const built = build({ agentIds: [] })
    coordinator = built.coordinator
    coordinator.start()
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual([])
  })

  it('drops the pending restore when a live session already exists', async () => {
    const storage = new FakeStorage()
    await storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'h-abc')
    const built = build({ storage, agentIds: [], hasActiveSession: () => true })
    coordinator = built.coordinator
    coordinator.start()
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual([])
    // Subsequent calls also do nothing — the pending id was cleared.
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual([])
  })

  it('clears the pending restore after the first call so a second call is a no-op', async () => {
    const storage = new FakeStorage()
    await storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'h-abc')
    const built = build({ storage, agentIds: [] })
    coordinator = built.coordinator
    coordinator.start()
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual(['h-abc'])
    // Second call: pending id was cleared on first invocation.
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual(['h-abc'])
  })

  it('swallows resumeSession failures without throwing', async () => {
    const storage = new FakeStorage()
    await storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'h-abc')
    const built = build({
      storage,
      agentIds: [],
      resumeSession: async () => {
        throw new Error('boom')
      },
    })
    coordinator = built.coordinator
    coordinator.start()
    await expect(coordinator.tryRestoreActiveSession()).resolves.toBeUndefined()
  })
})

describe('AcpSessionRestoreCoordinator — onWorkspaceSwap', () => {
  let coordinator: AcpSessionRestoreCoordinator | undefined

  afterEach(() => {
    coordinator?.dispose()
    coordinator = undefined
  })

  it('re-reads pending restore from the new bucket and resumes once', async () => {
    const storage = new FakeStorage()
    // Initial bucket: no active session.
    const built = build({ storage, agentIds: [] })
    coordinator = built.coordinator
    coordinator.start()
    await coordinator.tryRestoreActiveSession()
    expect(built.callbacks.resumeCalls).toEqual([])

    // After the swap, the new bucket has a pending id.
    await storage.set(ACP_ACTIVE_SESSION_STORAGE_KEY, 'h-new')
    await coordinator.onWorkspaceSwap()
    // onWorkspaceSwap itself triggers tryRestoreActiveSession internally; give
    // it a tick for any trailing microtasks before asserting.
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(built.callbacks.resumeCalls).toEqual(['h-new'])
  })
})

describe('AcpSessionRestoreCoordinator — hydrate sweep', () => {
  let coordinator: AcpSessionRestoreCoordinator | undefined

  afterEach(() => {
    coordinator?.dispose()
    coordinator = undefined
  })

  it('skips agents that do not advertise list capability', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    coordinator = built.coordinator
    // Default StubAgentOptions has empty capabilities — list cap absent.
    await built.history.initialize()
    coordinator.start()
    coordinator.requestHydrate()
    // Give the fire-and-forget hydrate a chance to land.
    await new Promise<void>((r) => setTimeout(r, 30))
    // Connection was opened (to learn capabilities) but no listSessions call.
    expect(built.client.connectCalls).toHaveLength(1)
    expect(built.client.agents[0]?.listCalls).toEqual([])
    // Connection was disposed.
    expect(built.client.disposed[0]).toBe(true)
  })

  it('walks session/list pages and bulk-merges into history when list capability is present', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [
        [
          {
            sessionId: 's1',
            cwd: 'C:/ws',
            title: 'one',
            updatedAt: '2026-01-01T00:00:00Z',
          } as unknown as SessionInfo,
        ],
        [
          {
            sessionId: 's2',
            cwd: 'C:/ws',
            title: 'two',
            updatedAt: '2026-01-02T00:00:00Z',
          } as unknown as SessionInfo,
        ],
      ],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    // Hydrate is fire-and-forget; await a generous tick.
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(built.client.agents[0]?.listCalls).toHaveLength(2)
    // Both pages merged into history.
    const titles = built.history.list().map((e) => e.title)
    expect(titles).toContain('one')
    expect(titles).toContain('two')
  })

  it('swallows initialize errors and records nothing to history', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      initializeError: { code: -32603, message: 'init blew up' },
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.history.list()).toEqual([])
    // Connection still disposed.
    expect(built.client.disposed[0]).toBe(true)
  })

  it('swallows connect() rejections', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.rejectAgents.add('fake')
    await built.history.initialize()
    coordinator = built.coordinator
    expect(() => {
      coordinator!.start()
      coordinator!.requestHydrate()
    }).not.toThrow()
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(built.history.list()).toEqual([])
  })

  it('connects with silent:true so a spawn failure never surfaces a notification', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.rejectAgents.add('fake')
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(built.client.connectCalls).toEqual([{ agentId: 'fake', cwd: 'C:/ws', silent: true }])
    expect(built.notifications.captured).toEqual([])
  })

  it('does not auto-fire on start() — hydrate must be requested explicitly', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [[]],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    // Without requestHydrate(), no agent connection is opened.
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.client.connectCalls).toHaveLength(0)
  })

  it('is idempotent within the same workspace cwd', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [[]],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.client.connectCalls).toHaveLength(1)
    // Second request: must NOT spawn another connection.
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.client.connectCalls).toHaveLength(1)
  })

  it('refresh() bypasses the cwd idempotency gate and re-runs session/list', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [[]],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.client.connectCalls).toHaveLength(1)
    // Forced refresh: idempotency gate must not short-circuit even though cwd is unchanged.
    await coordinator.refresh()
    expect(built.client.connectCalls).toHaveLength(2)
    expect(built.client.agents[0]?.listCalls).toHaveLength(1)
    expect(built.client.agents[1]?.listCalls).toHaveLength(1)
  })

  it('refresh() folds concurrent calls onto a single in-flight sweep', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [[]],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    // Three back-to-back refresh calls before the first resolves.
    const a = coordinator.refresh()
    const b = coordinator.refresh()
    const c = coordinator.refresh()
    await Promise.all([a, b, c])
    expect(built.client.connectCalls).toHaveLength(1)
  })

  it('re-hydrates after onWorkspaceSwap resets the gate', async () => {
    const storage = new FakeStorage()
    let currentCwd: string | undefined = 'C:/ws-A'
    const client = new FakeAcpClientService()
    const registry = new FakeAgentRegistry(['fake'])
    const history = new AcpSessionHistoryService(
      storage,
      new FakeWorkspaceService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      FAKE_URI_IDENTITY,
    )
    client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [[]],
    })
    const callbacks: RestoreCoordinatorCallbacks = {
      resumeSession: async (historyId: string) =>
        ({ id: 'live', historyId }) as unknown as IAcpSession,
      hasActiveSession: () => false,
      getCurrentCwd: () => currentCwd,
      whenWorkspaceReady: () => Promise.resolve(),
      getLiveSessionIds: () => new Set<string>(),
      getHistoryScope: () => 'workspace',
    }
    coordinator = new AcpSessionRestoreCoordinator(
      client,
      registry,
      history,
      storage,
      new StubNotificationService(),
      new NoopTelemetryService(),
      new StubLoggerService(),
      FAKE_URI_IDENTITY,
      callbacks,
    )
    await history.initialize()
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(client.connectCalls).toEqual([{ agentId: 'fake', cwd: 'C:/ws-A', silent: true }])

    currentCwd = 'C:/ws-B'
    await coordinator.onWorkspaceSwap()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(client.connectCalls).toEqual([
      { agentId: 'fake', cwd: 'C:/ws-A', silent: true },
      { agentId: 'fake', cwd: 'C:/ws-B', silent: true },
    ])
  })

  it('defers the hydrate sweep until whenWorkspaceReady resolves', async () => {
    let resolveReady!: () => void
    const ready = new Promise<void>((r) => {
      resolveReady = r
    })
    const built = build({
      agentIds: ['fake'],
      cwd: 'C:/ws',
      whenWorkspaceReady: ready,
    })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [
        [
          {
            sessionId: 's1',
            cwd: 'C:/ws',
            title: 'one',
            updatedAt: '2026-01-01T00:00:00Z',
          } as unknown as SessionInfo,
        ],
      ],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    // Before workspace is ready: no connect should have happened.
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(built.client.connectCalls).toHaveLength(0)
    // Resolve workspace ready → hydrate proceeds.
    resolveReady()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(built.client.connectCalls).toHaveLength(1)
    expect(built.history.list().map((e) => e.title)).toEqual(['one'])
  })

  it('drops cross-workspace sessions returned by an agent that ignores the cwd filter', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws-A' })
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { list: {} } } as AgentCapabilities,
      listPages: [
        [
          {
            sessionId: 's-A',
            cwd: 'C:/ws-A',
            title: 'mine',
            updatedAt: '2026-01-01T00:00:00Z',
          } as unknown as SessionInfo,
          {
            sessionId: 's-B',
            cwd: 'C:/ws-B',
            title: 'theirs',
            updatedAt: '2026-01-02T00:00:00Z',
          } as unknown as SessionInfo,
        ],
      ],
    })
    await built.history.initialize()
    coordinator = built.coordinator
    coordinator.start()
    coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
    const titles = built.history.list().map((e) => e.title)
    expect(titles).toContain('mine')
    expect(titles).not.toContain('theirs')
  })
})

describe('AcpSessionRestoreCoordinator — deleteOnAgent', () => {
  let coordinator: AcpSessionRestoreCoordinator | undefined

  afterEach(() => {
    coordinator?.dispose()
    coordinator = undefined
  })

  async function seedAgentCaps(
    built: BuildResult,
    caps: AgentCapabilities | undefined,
  ): Promise<void> {
    if (caps !== undefined) {
      built.client.agentOptions.set('fake', { capabilities: caps })
    }
    // Trigger hydrate so `_agentCaps` gets populated. Without this, deleteOnAgent
    // can't tell whether `delete` is supported and returns 'unsupported'.
    built.coordinator.start()
    built.coordinator.requestHydrate()
    await new Promise<void>((r) => setTimeout(r, 30))
  }

  it('returns unknown when the history entry does not exist', async () => {
    const built = build({ agentIds: [] })
    coordinator = built.coordinator
    await built.history.initialize()
    const result = await coordinator.deleteOnAgent('does-not-exist')
    expect(result).toBe('unknown')
  })

  it('returns unsupported when the agent does not advertise sessionCapabilities.delete', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    coordinator = built.coordinator
    await built.history.initialize()
    const entry = built.history.add({
      agentId: 'fake',
      sessionIdOnAgent: 'agent-x',
      title: 'x',
    })
    await seedAgentCaps(built, { sessionCapabilities: { list: {} } } as AgentCapabilities)
    const result = await coordinator.deleteOnAgent(entry.id)
    expect(result).toBe('unsupported')
  })

  it('returns ok and dispatches session/delete when delete capability is present', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    coordinator = built.coordinator
    await built.history.initialize()
    const entry = built.history.add({
      agentId: 'fake',
      sessionIdOnAgent: 'agent-x',
      title: 'x',
    })
    await seedAgentCaps(built, {
      sessionCapabilities: { delete: {} },
    } as unknown as AgentCapabilities)
    const result = await coordinator.deleteOnAgent(entry.id)
    expect(result).toBe('ok')
    // The second connect is the delete call; the first was hydrate.
    expect(built.client.connectCalls.length).toBeGreaterThanOrEqual(2)
    // Best-effort background calls must never surface a spawn-failure toast.
    expect(built.client.connectCalls.every((c) => c.silent === true)).toBe(true)
    const deleteAgent = built.client.agents[built.client.agents.length - 1]
    expect(deleteAgent?.deleteCalls).toEqual([{ sessionId: 'agent-x' }])
    // Both connections disposed.
    expect(built.client.disposed.every((d) => d)).toBe(true)
  })

  it('returns error when the agent rejects unstable_deleteSession', async () => {
    const built = build({ agentIds: ['fake'], cwd: 'C:/ws' })
    coordinator = built.coordinator
    await built.history.initialize()
    const entry = built.history.add({
      agentId: 'fake',
      sessionIdOnAgent: 'agent-x',
      title: 'x',
    })
    // Hydrate first to register capabilities.
    await seedAgentCaps(built, {
      sessionCapabilities: { delete: {} },
    } as unknown as AgentCapabilities)
    // Reconfigure so the next connect returns an agent that throws from delete.
    built.client.agentOptions.set('fake', {
      capabilities: { sessionCapabilities: { delete: {} } } as unknown as AgentCapabilities,
      deleteError: { code: -32603, message: 'cant delete' },
    })
    const result = await coordinator.deleteOnAgent(entry.id)
    expect(result).toBe('error')
    // The connection used for the failing delete was still disposed.
    expect(built.client.disposed[built.client.disposed.length - 1]).toBe(true)
  })
})

describe('AcpSessionRestoreCoordinator — notifyFailure', () => {
  let coordinator: AcpSessionRestoreCoordinator | undefined

  afterEach(() => {
    coordinator?.dispose()
    coordinator = undefined
  })

  it('forwards the message to the notification service with Error severity', () => {
    const built = build({ agentIds: [] })
    coordinator = built.coordinator
    coordinator.notifyFailure('something went wrong')
    expect(built.notifications.captured).toEqual([
      { message: 'something went wrong', severity: Severity.Error },
    ])
  })
})
