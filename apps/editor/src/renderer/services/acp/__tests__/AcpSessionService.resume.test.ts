/*---------------------------------------------------------------------------------------------
 *  Stage 10 tests for AcpSessionService — resumeSession path. The fake ACP
 *  client lets each test seed the agent's `initialize` and `session/load`
 *  responses so we can exercise:
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
import { AcpSessionHistoryService } from '../acpSessionHistory.js'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parameterized fake AcpClient
// ---------------------------------------------------------------------------

interface FakeAcpClientOptions {
  /** Replace the default initialize result (default: { protocolVersion: 1, agentCapabilities: { loadSession: true } }). */
  initializeResult?: unknown
  /** Per-call override for session/load result (default: empty object). */
  loadSessionResult?: unknown
  /** Throw an RPC error from session/load instead of returning a result. */
  loadSessionError?: { code: number; message: string }
  /** Inject notifications onto the wire BEFORE acknowledging session/load. */
  loadSessionUpdates?: readonly AcpSessionUpdateParams[]
}

interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly harness: IAcpTransportTestHarness
  readonly connection: AcpConnection
  cleanup(): void
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  readonly callCounts: Record<string, number> = {}
  readonly connectArgs: { agentId: string; cwd: string | undefined }[] = []
  private _agentSeq = 0

  constructor(private readonly _opts: FakeAcpClientOptions = {}) {}

  async connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<AcpConnection> {
    this.connectArgs.push({ agentId, cwd: options?.cwd })
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
        }
        if (typeof msg.id !== 'number' && typeof msg.id !== 'string') continue
        if (msg.method === AcpMethods.Initialize) {
          this._respond(
            harness,
            msg.id,
            this._opts.initializeResult ?? {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
            },
          )
        } else if (msg.method === AcpMethods.NewSession) {
          this._respond(harness, msg.id, { sessionId: agentSessionId })
        } else if (msg.method === AcpMethods.LoadSession) {
          // Use the params' sessionId since session/load passes back what we sent.
          // Stream any pre-load notifications first to verify the routing path.
          for (const upd of this._opts.loadSessionUpdates ?? []) {
            harness.inject(
              JSON.stringify({ jsonrpc: '2.0', method: AcpMethods.SessionUpdate, params: upd }) +
                '\n',
            )
          }
          if (this._opts.loadSessionError) {
            this._respondError(harness, msg.id, this._opts.loadSessionError)
          } else {
            this._respond(harness, msg.id, this._opts.loadSessionResult ?? {})
          }
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

    const cleanup = (): void => clearInterval(interval)
    conn.onExit(cleanup)
    this.connected.push({ sink, harness, connection: conn, cleanup })
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

// ---------------------------------------------------------------------------
// Helper: build a service with a freshly-instantiated history service.
// We reuse the real AcpSessionHistoryService against a FakeStorage so tests
// exercise the same code paths as production (LRU truncation, debounce, etc.).
// ---------------------------------------------------------------------------

function buildService(opts: FakeAcpClientOptions = {}): {
  svc: AcpSessionService
  client: FakeAcpClientService
  history: AcpSessionHistoryService
  notifications: StubNotificationService
  storage: FakeStorage
} {
  const client = new FakeAcpClientService(opts)
  const config: IConfigurationService = new ConfigurationService()
  const telemetry: ITelemetryService = new NoopTelemetryService()
  const notifications = new StubNotificationService()
  const storage = new FakeStorage()
  const history = new AcpSessionHistoryService(storage, telemetry, new StubLoggerService())
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
  )
  return { svc, client, history, notifications, storage }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSessionService — historyId routing (editor restart)', () => {
  let svc: AcpSessionService

  afterEach(() => {
    svc?.dispose()
  })

  it('exposes historyId on the IAcpSession returned by createSession', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const session = await svc.createSession()
    const historyId = built.history.list()[0]?.id
    expect(historyId).toBeDefined()
    expect(session.historyId).toBe(historyId)
  })

  it('getByHistoryId returns the live session with that history id', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const a = await svc.createSession()
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.createSession()
    expect(svc.getByHistoryId(a.historyId!)?.id).toBe(a.id)
    expect(svc.getByHistoryId(b.historyId!)?.id).toBe(b.id)
  })

  it('getByHistoryId returns undefined when no live session matches', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    expect(svc.getByHistoryId('nope')).toBeUndefined()
  })

  it('resumeSession yields a session whose historyId matches the resumed entry', async () => {
    const built = buildService({ loadSessionResult: {} })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = original.historyId!
    await svc.closeSession(original.id)
    const resumed = await svc.resumeSession(historyId)
    expect(resumed.historyId).toBe(historyId)
    expect(svc.getByHistoryId(historyId)?.id).toBe(resumed.id)
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
    // Force timestamp drift so the assertion is meaningful.
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.createSession()
    expect(built.history.list().map((e) => e.title)).toEqual([b.title, a.title])
    await new Promise((r) => setTimeout(r, 5))
    // Bumping `a` via sendPrompt should reorder it to the head. The fake
    // never acks session/prompt, but `history.touch()` runs synchronously at
    // the start of sendPrompt so we don't await the prompt promise — we
    // cancel it after the synchronous touch lands.
    void a.sendPrompt('hi')
    expect(built.history.list().map((e) => e.title)).toEqual([a.title, b.title])
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
    await expect(svc.resumeSession('bogus')).rejects.toThrow(/Unknown agent session history id/)
    expect(built.client.connected).toHaveLength(0)
  })

  it('reuses an already-live session if its sessionIdOnAgent matches', async () => {
    const built = buildService()
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    expect(built.client.connected).toHaveLength(1)
    // resumeSession should NOT spawn a second agent — it should setActive(original).
    svc.setActive(original.id) // no-op but keeps the focus explicit
    const resumed = await svc.resumeSession(historyId)
    expect(resumed.id).toBe(original.id)
    expect(built.client.connected).toHaveLength(1)
    expect(svc.activeSession.get()?.id).toBe(original.id)
  })

  it('spawns a fresh agent and applies session/load state when capability=true', async () => {
    const configFixture: AcpSessionConfigOption = {
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
    const modesFixture: AcpSessionModeState = {
      currentModeId: 'plan',
      availableModes: [{ id: 'plan', name: 'Plan' }],
    }
    // Bootstrap step: createSession to populate history, then dispose the live
    // session so resumeSession spawns a fresh agent for it.
    const built = buildService({
      loadSessionResult: { configOptions: [configFixture], modes: modesFixture },
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
    // session/load state has been applied through applyInitState.
    const opts = resumed.configOptions.get()
    expect(opts.find((o) => o.id === 'model')?.currentValue).toBe('opus')
    expect(opts.some((o) => o.category === 'mode')).toBe(true)
    expect(built.client.callCounts[AcpMethods.LoadSession]).toBe(1)
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
    // The streamed chunk should have landed on the resumed session.
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
      initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
    })
    svc = built.svc
    await built.history.initialize()
    const original = await svc.createSession()
    const historyId = built.history.list()[0]!.id
    await svc.closeSession(original.id)

    await expect(svc.resumeSession(historyId)).rejects.toThrow(/does not advertise.*loadSession/)
    // No partial state left around.
    expect(svc.sessions.get()).toHaveLength(0)
    expect(built.notifications.captured.length).toBe(1)
  })

  it('rejects when initialize returns malformed payload', async () => {
    const built = buildService({ initializeResult: { protocolVersion: 'oops' } })
    svc = built.svc
    await built.history.initialize()
    // Bootstrap history with one entry using a fresh service that returns valid initialize.
    const bootstrap = buildService()
    await bootstrap.history.initialize()
    await bootstrap.svc.createSession()
    const historyId = bootstrap.history.list()[0]!.id
    bootstrap.svc.dispose()

    // Hand the entry to `svc`'s history via direct add (storage is a separate FakeStorage).
    built.history.add({
      agentId: 'fake',
      sessionIdOnAgent: 'agent-bootstrap',
      title: 'Fake Agent · s1',
    })
    const ids = built.history.list().map((e) => e.id)
    expect(ids.length).toBeGreaterThan(0)
    void historyId

    await expect(svc.resumeSession(ids[0]!)).rejects.toThrow(/initialize returned malformed/)
    expect(svc.sessions.get()).toHaveLength(0)
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
})
