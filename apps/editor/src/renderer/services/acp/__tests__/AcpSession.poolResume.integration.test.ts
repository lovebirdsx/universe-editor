/*---------------------------------------------------------------------------------------------
 *  High-fidelity reproduction for the "switch to the 2nd restored session →
 *  spins forever" bug.
 *
 *  Unlike AcpSessionService.resume.test.ts (which stubs IAcpClientService and
 *  therefore creates a brand-new connection per connect()), this test drives the
 *  REAL AcpClientService — including its connection pool — so two sessions rooted
 *  in the same cwd share ONE pooled ClientSideConnection backed by ONE in-memory
 *  agent process. That shared-connection path is exactly what the production bug
 *  lives in, and what the non-pooling fake could never exercise.
 *
 *  The in-memory host bridges IAcpHostService's string stdio to a real
 *  AgentSideConnection running a stub Agent, so initialize / newSession /
 *  loadSession all flow over a genuine ACP wire.
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
  IFileService,
  IHostService,
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IOutputChannel,
  IOutputService,
  IProgressOptions,
  IProgressService,
  IProgressStep,
  IStorageService,
  IWorkspace,
  IWorkspaceService,
} from '@universe-editor/platform'
import { CancellationToken } from '@universe-editor/platform'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import type {
  AcpExitEvent,
  AcpStdioChunk,
  IAcpHostService,
} from '../../../../shared/ipc/acpHostService.js'
import type { IAcpTerminalService } from '../../../../shared/ipc/acpTerminalService.js'
import type { IClaudeBinaryService } from '../../../../shared/ipc/claudeBinaryService.js'
import type { ICodexBinaryService } from '../../../../shared/ipc/codexBinaryService.js'
import { AcpClientService } from '../acpClientService.js'
import { AcpPathPolicy } from '../acpPathPolicy.js'
import { AcpSessionService } from '../acpSessionService.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'

const FAKE_HOST: IHostService = { platform: 'linux' } as IHostService

// ---------------------------------------------------------------------------
// In-memory host that bridges string stdio to a real AgentSideConnection.
// ---------------------------------------------------------------------------

class StubAgent implements Agent {
  connection?: AgentSideConnection
  readonly loadSessionCalls: string[] = []
  newSessionCount = 0
  initializeCount = 0
  private _seq = 0

  initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCount++
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
  }

  newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionCount++
    return Promise.resolve({ sessionId: `sess-${++this._seq}` } as unknown as NewSessionResponse)
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.loadSessionCalls.push(params.sessionId)
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }

  prompt(_params: PromptRequest): Promise<PromptResponse> {
    return new Promise<never>(() => {})
  }

  cancel(_params: CancelNotification): Promise<void> {
    return Promise.resolve()
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

interface BridgedHost {
  readonly host: IAcpHostService
  readonly agents: StubAgent[]
  starts(): number
  dispose(): void
}

function createBridgedAcpHost(): BridgedHost {
  const onStdout = new Emitter<AcpStdioChunk>()
  const onStderr = new Emitter<AcpStdioChunk>()
  const onExit = new Emitter<AcpExitEvent>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const agents: StubAgent[] = []
  let startCount = 0
  let handleSeq = 0

  interface Live {
    readonly agent: StubAgent
    readonly conn: AgentSideConnection
    push(u8: Uint8Array): void
    closed: boolean
  }
  const live = new Map<string, Live>()

  const host: IAcpHostService = {
    _serviceBrand: undefined,
    onStdout: onStdout.event,
    onStderr: onStderr.event,
    onExit: onExit.event,
    start: () => {
      startCount++
      const handle = `mem-${++handleSeq}`
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c
        },
      })
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          onStdout.fire({ handle, data: decoder.decode(chunk) })
        },
      })
      const stream = ndJsonStream(writable, readable)
      const agent = new StubAgent()
      const conn = new AgentSideConnection(() => agent, stream)
      agent.connection = conn
      agents.push(agent)
      live.set(handle, {
        agent,
        conn,
        closed: false,
        push: (u8) => controller?.enqueue(u8),
      })
      return Promise.resolve({ handle })
    },
    writeStdin: (handle, data) => {
      const l = live.get(handle)
      if (l && !l.closed) l.push(encoder.encode(data))
      return Promise.resolve()
    },
    stop: (handle) => {
      const l = live.get(handle)
      if (l && !l.closed) {
        l.closed = true
        onExit.fire({ handle, code: 0, signal: null })
      }
      return Promise.resolve()
    },
    probe: () => Promise.resolve(true),
  }

  return {
    host,
    agents,
    starts: () => startCount,
    dispose: () => {
      onStdout.dispose()
      onStderr.dispose()
      onExit.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Stub platform services (cribbed from the sibling ACP test files).
// ---------------------------------------------------------------------------

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake Agent', command: '/x', args: [] }]
  }
  allAgentIds(): readonly string[] {
    return ['fake']
  }
  get(_agentId: string) {
    return this.list()[0]!
  }
  resolve(_agentId: string, cwd?: string) {
    return { command: '/x', args: [], ...(cwd !== undefined ? { cwd } : {}) }
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
  tryAutoApprove() {
    return undefined
  }
  persistAllow(): void {}
}

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._onDidChangeWorkspaceScope.event
  constructor(seed?: Map<string, unknown>) {
    if (seed) for (const [k, v] of seed) this.store.set(k, v)
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

class StubOutputChannel implements IOutputChannel {
  readonly name: string
  readonly content: IObservable<string> = observableValue<string>('stub.output.content', '')
  constructor(name: string) {
    this.name = name
  }
  append(): void {}
  appendLine(): void {}
  clear(): void {}
  dispose(): void {}
}

class StubOutputService implements IOutputService {
  declare readonly _serviceBrand: undefined
  readonly channels = new Map<string, StubOutputChannel>()
  readonly channelNames: IObservable<readonly string[]> = observableValue<readonly string[]>(
    'stub.channels',
    [],
  )
  readonly activeChannelName: IObservable<string | undefined> = observableValue<string | undefined>(
    'stub.activeChannelName',
    undefined,
  )
  readonly activeChannelContent: IObservable<string> = observableValue<string>(
    'stub.activeChannelContent',
    '',
  )
  activeChannel: IOutputChannel | undefined = undefined
  createChannel(name: string): IOutputChannel {
    const ch = new StubOutputChannel(name)
    this.channels.set(name, ch)
    return ch
  }
  getChannel(name: string): IOutputChannel | undefined {
    return this.channels.get(name)
  }
  getChannels(): readonly IOutputChannel[] {
    return [...this.channels.values()]
  }
  hasPendingRestoredChannel: boolean = false
  setActiveChannel(): void {}
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface Built {
  readonly client: AcpClientService
  readonly svc: AcpSessionService
  readonly history: AcpSessionHistoryService
  readonly bridge: BridgedHost
  readonly notifications: StubNotificationService
  dispose(): void
}

function build(storage: FakeStorage): Built {
  const bridge = createBridgedAcpHost()
  const telemetry = new NoopTelemetryService()
  const config: IConfigurationService = new ConfigurationService()
  const notifications = new StubNotificationService()
  const pathPolicy = new AcpPathPolicy({ platform: 'linux', home: '/home/user' })
  const terminals = {
    _serviceBrand: undefined,
    create: async () => ({ terminalId: 't' }),
    output: async () => ({ output: '', truncated: false }),
    waitForExit: async () => ({ exitCode: 0 }),
    kill: async () => {},
    release: async () => {},
  } as unknown as IAcpTerminalService
  const claudeBinary = {
    onDidChangeProgress: new Emitter<never>().event,
    resolve: () => Promise.resolve({ path: '/x' }),
  } as unknown as IClaudeBinaryService
  const codexBinary = {
    onDidChangeProgress: new Emitter<never>().event,
    resolve: () => Promise.resolve({ path: '/x' }),
  } as unknown as ICodexBinaryService
  const client = new AcpClientService(
    bridge.host,
    new FakeAgentRegistry(),
    pathPolicy,
    {} as IFileService,
    new StubOutputService(),
    notifications,
    telemetry,
    terminals,
    claudeBinary,
    codexBinary,
    config,
    new StubProgressService(),
    new StubLoggerService(),
    FAKE_HOST,
  )
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
    new StubSessionChangeTracker(),
    FAKE_HOST,
  )
  return {
    client,
    svc,
    history,
    bridge,
    notifications,
    dispose: () => {
      svc.dispose()
      client.dispose()
      bridge.dispose()
    },
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACP pooled resume — two sessions, one cwd (editor restart)', () => {
  let built: Built | undefined

  afterEach(() => {
    built?.dispose()
    built = undefined
  })

  it('resumes BOTH same-cwd sessions over the shared pooled connection after restart', async () => {
    // -- Round 1: create two sessions in the same (null) workspace cwd. --------
    const storage = new FakeStorage()
    const round1 = build(storage)
    await round1.history.initialize()
    const s1 = await round1.svc.createSession()
    const s2 = await round1.svc.createSession()
    expect(s1.id).not.toBe(s2.id)
    // Both sessions share ONE pooled agent process.
    expect(round1.bridge.starts()).toBe(1)
    // Persist history writes (100ms debounce) then tear the editor down.
    await new Promise((r) => setTimeout(r, 150))
    round1.dispose()

    // -- Round 2: "restart" — fresh services + pool, same storage. ------------
    built = build(storage)
    await built.history.initialize()
    const ids = built.history.list().map((e) => e.id)
    expect(ids).toContain(s1.id)
    expect(ids).toContain(s2.id)

    // Restore the first session (the auto-restored active one). Works today.
    const r1 = await withTimeout(built.svc.resumeSession(s1.id), 3000, 'resume S1')
    expect(r1.id).toBe(s1.id)

    // Switch to the second session. THIS is where production spins forever.
    const r2 = await withTimeout(built.svc.resumeSession(s2.id), 3000, 'resume S2')
    expect(r2.id).toBe(s2.id)

    expect(built.svc.getById(s1.id)?.id).toBe(s1.id)
    expect(built.svc.getById(s2.id)?.id).toBe(s2.id)
    // One agent process, one initialize, two loadSessions (one per session).
    expect(built.bridge.starts()).toBe(1)
    const agent = built.bridge.agents[0]!
    expect(agent.loadSessionCalls).toEqual([s1.id, s2.id])
  })
})
