/*---------------------------------------------------------------------------------------------
 *  Tests for the elicitation protocol path (elicitation/create +
 *  elicitation/complete): capability advertisement, sink routing by
 *  sessionId, Promise-settle round-trip back to the agent, supersede and
 *  session-close cancellation. Drives AcpSessionService with a fake
 *  AcpClientService backed by an in-memory ACP stream pair + a stub Agent,
 *  so the elicitation crosses the real SDK wire (zod validation included).
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
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { AcpAuthGuidanceService } from '../acpAuthGuidanceService.js'
import { AcpSessionFactory } from '../acpSessionFactory.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubExtensionMcpServersService } from './stubExtensionMcpServers.js'
import { StubMcpServerEnablementService } from './stubMcpServerEnablement.js'
import { StubFileService } from './stubFileService.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import {
  IAcpClientService,
  getDefaultInitParamsForTests,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../../acpClientService.js'
import type { IAcpAgentRegistry } from '../../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../../acpPermissionHandler.js'
import { createInMemoryAcpPair } from '../../testing/inMemoryAcpPair.js'
import { stubWindowsService } from './stubWindowsService.js'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')
const AGENT_SESSION_ID = 'agent-1'

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake Agent', command: '/x', args: [] }]
  }
  allAgentIds(): readonly string[] {
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
  tryAutoApprove(_params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    return undefined
  }
  persistAllow(_kind: string): void {}
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

class StubAgent implements Agent {
  readonly initializeCalls: InitializeRequest[] = []

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeCalls.push(params)
    return {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: AGENT_SESSION_ID } as unknown as NewSessionResponse
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: 'end_turn' } as unknown as PromptResponse
  }

  async cancel(_params: CancelNotification): Promise<void> {}

  async setSessionConfigOption(
    _params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return {} as unknown as SetSessionConfigOptionResponse
  }

  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return {} as unknown as LoadSessionResponse
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {}
}

interface ConnectedSession {
  sink: IAcpClientNotificationSink
  agent: StubAgent
  agentConn: AgentSideConnection
  clientConn: ClientSideConnection
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  private _sink: IAcpClientNotificationSink | undefined

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  drainAll(): void {}

  killConnectionFor(): void {}

  async connect(_agentId: string): Promise<IAcpClientConnection> {
    const sink = this._sink
    if (!sink) throw new Error('FakeAcpClientService.connect: sink not installed')
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent()
    const agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    const clientImpl: Client = {
      requestPermission: (params) => sink.onRequestPermission(params),
      unstable_createElicitation: (params) => sink.onCreateElicitation(params),
      unstable_completeElicitation: async (params) => {
        sink.onCompleteElicitation?.(params)
      },
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
        elicitation: { form: {}, url: {} },
      },
    })
    initializeResult.catch(() => {})
    this.connected.push({ sink, agent, agentConn, clientConn })
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      // Deliberately does NOT close the streams: tests assert on responses that
      // flush after a session-close settle, and an immediate close would race
      // them. The in-memory pair is GC'd with the test.
      dispose: (): void => {},
    }
  }
}

function makeService(client: FakeAcpClientService): AcpSessionService {
  const notifications = new StubNotificationService()
  const config: IConfigurationService = new ConfigurationService()
  const telemetry: ITelemetryService = new NoopTelemetryService()
  const storage = new FakeStorage()
  const workspace = new FakeWorkspaceService()
  const loggerService = new StubLoggerService()
  const history = new AcpSessionHistoryService(
    storage,
    workspace,
    telemetry,
    loggerService,
    FAKE_URI_IDENTITY,
  )
  const agentDefaults = new AcpAgentDefaultsService(
    new FakeStorage(),
    workspace,
    telemetry,
    loggerService,
  )
  return new AcpSessionService(
    client,
    new FakeAgentRegistry(),
    workspace,
    config,
    notifications,
    telemetry,
    new StubPermissionHandler(),
    loggerService,
    history,
    new FakeStorage(),
    agentDefaults,
    new StubConfigOptionsCache(),
    FAKE_URI_IDENTITY,
    new AcpAuthGuidanceService(notifications, {
      executeCommand: async () => undefined,
    } as never),
    new AcpSessionFactory(
      telemetry,
      history,
      agentDefaults,
      new StubSessionChangeTracker(),
      new StubSessionTitleService(),
      new AcpCompactionStatsService(new FakeStorage(), telemetry, loggerService),
    ),
    new StubFileService(),
    new StubExtensionMcpServersService(),
    new StubMcpServerEnablementService(),
    stubWindowsService(),
  )
}

/** The form elicitation the stub agent sends for a given session. */
function formRequest(sessionId: string) {
  return {
    sessionId,
    mode: 'form' as const,
    message: 'Tell me things',
    requestedSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string' as const, title: 'Name' } },
      required: ['name'],
    },
  }
}

describe('AcpSessionService — elicitation', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  beforeEach(() => {
    client = new FakeAcpClientService()
    svc = makeService(client)
  })

  afterEach(() => {
    svc.dispose()
  })

  it('advertises elicitation.form and elicitation.url in the default init params', () => {
    const caps = getDefaultInitParamsForTests().clientCapabilities
    expect(caps?.elicitation?.form).toEqual({})
    expect(caps?.elicitation?.url).toEqual({})
  })

  it('presents elicitation/create on the matching session and round-trips accept+content', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(formRequest(AGENT_SESSION_ID))
    await waitFor(() => s.pendingElicitation.get() !== undefined)

    const pending = s.pendingElicitation.get()!
    expect(pending.request.mode).toBe('form')
    expect(pending.request.message).toBe('Tell me things')
    pending.resolve({ action: 'accept', content: { name: 'universe' } })

    await expect(agentPromise).resolves.toEqual({
      action: 'accept',
      content: { name: 'universe' },
    })
    expect(s.pendingElicitation.get()).toBeUndefined()
  })

  it('settles decline back to the agent', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(formRequest(AGENT_SESSION_ID))
    await waitFor(() => s.pendingElicitation.get() !== undefined)
    s.pendingElicitation.get()!.resolve({ action: 'decline' })

    await expect(agentPromise).resolves.toEqual({ action: 'decline' })
  })

  it('cancels immediately for an unknown session', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    await expect(
      conn.agentConn.unstable_createElicitation(formRequest('no-such-session')),
    ).resolves.toEqual({ action: 'cancel' })
    expect(s.pendingElicitation.get()).toBeUndefined()
  })

  it('a newer elicitation supersedes the prior pending one (settled as cancel)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const first = conn.agentConn.unstable_createElicitation(formRequest(AGENT_SESSION_ID))
    await waitFor(() => s.pendingElicitation.get() !== undefined)
    const firstPending = s.pendingElicitation.get()!
    const second = conn.agentConn.unstable_createElicitation(formRequest(AGENT_SESSION_ID))
    await waitFor(() => s.pendingElicitation.get() !== firstPending)

    await expect(first).resolves.toEqual({ action: 'cancel' })
    s.pendingElicitation.get()!.resolve({ action: 'decline' })
    await expect(second).resolves.toEqual({ action: 'decline' })
  })

  it('closeSession cancels the pending elicitation', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(formRequest(AGENT_SESSION_ID))
    await waitFor(() => s.pendingElicitation.get() !== undefined)

    await svc.closeSession(s.id)

    await expect(agentPromise).resolves.toEqual({ action: 'cancel' })
    expect(s.pendingElicitation.get()).toBeUndefined()
  })

  it('elicitation/complete is accepted and ignored (unknown id)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    await expect(
      conn.agentConn.unstable_completeElicitation({ elicitationId: 'el-1' }),
    ).resolves.toBeUndefined()
  })

  /** A url elicitation the stub agent sends for a given session. */
  function urlRequest(sessionId: string, elicitationId: string) {
    return {
      sessionId,
      mode: 'url' as const,
      message: 'Authorize the thing',
      url: 'https://auth.example.com/flow?token=abc',
      elicitationId,
    }
  }

  it('url accept keeps the card waiting; elicitation/complete flips it to done; dismiss tears down', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(
      urlRequest(AGENT_SESSION_ID, 'el-url-1') as never,
    )
    await waitFor(() => s.pendingElicitation.get() !== undefined)

    const pending = s.pendingElicitation.get()!
    expect(pending.urlState?.get()).toBe('consent')
    pending.resolve({ action: 'accept' })

    // accept settles the agent's promise but the card stays in waiting state.
    await expect(agentPromise).resolves.toEqual({ action: 'accept' })
    expect(s.pendingElicitation.get()).toBe(pending)
    expect(pending.urlState?.get()).toBe('waiting')

    // The agent signals completion → done; the card is still up for review.
    // (elicitation/complete is a notification — the await only covers the
    // stream write, so poll for the client-side processing.)
    await conn.agentConn.unstable_completeElicitation({ elicitationId: 'el-url-1' })
    await waitFor(() => pending.urlState?.get() === 'done')
    expect(s.pendingElicitation.get()).toBe(pending)

    // Dismiss is a local teardown — no further wire traffic to assert.
    pending.dismiss!()
    expect(s.pendingElicitation.get()).toBeUndefined()
  })

  it('url decline settles and tears the card down', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(
      urlRequest(AGENT_SESSION_ID, 'el-url-2') as never,
    )
    await waitFor(() => s.pendingElicitation.get() !== undefined)
    s.pendingElicitation.get()!.resolve({ action: 'decline' })

    await expect(agentPromise).resolves.toEqual({ action: 'decline' })
    expect(s.pendingElicitation.get()).toBeUndefined()

    // A late complete for the torn-down elicitation is silently ignored.
    await expect(
      conn.agentConn.unstable_completeElicitation({ elicitationId: 'el-url-2' }),
    ).resolves.toBeUndefined()
  })

  it('closeSession on a waiting url card unregisters it (late complete is ignored)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const agentPromise = conn.agentConn.unstable_createElicitation(
      urlRequest(AGENT_SESSION_ID, 'el-url-3') as never,
    )
    await waitFor(() => s.pendingElicitation.get() !== undefined)
    const pending = s.pendingElicitation.get()!
    pending.resolve({ action: 'accept' })
    await expect(agentPromise).resolves.toEqual({ action: 'accept' })
    expect(pending.urlState?.get()).toBe('waiting')

    await svc.closeSession(s.id)
    expect(s.pendingElicitation.get()).toBeUndefined()

    // The elicitationId was unregistered on close — the agent's late complete
    // must not resurrect state on a dead session. Give the notification a
    // chance to be processed before asserting the negative.
    await conn.agentConn.unstable_completeElicitation({ elicitationId: 'el-url-3' })
    await new Promise((r) => setTimeout(r, 50))
    expect(pending.urlState?.get()).toBe('waiting')
  })
})

/** Poll a condition with microtask-friendly waits (no fake timers involved). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
