/*---------------------------------------------------------------------------------------------
 *  Tests for AcpSessionService.closeSession — verifies that the
 *  `onDidCloseSession` event fires correctly (which AgentsSessionEditorLifecycleContribution
 *  uses to close the corresponding editor tabs).
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
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
import { AcpAgentDefaultsService } from '../acpAgentDefaultsService.js'
import { StubSessionChangeTracker } from './stubSessionChangeTracker.js'
import { StubConfigOptionsCache } from './stubConfigOptionsCache.js'
import { StubSessionTitleService } from './stubSessionTitleService.js'
import {
  IAcpClientService,
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../acpPermissionHandler.js'
import { createInMemoryAcpPair } from '../testing/inMemoryAcpPair.js'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')

// ---------------------------------------------------------------------------
// Minimal stubs (mirrors the pattern in AcpSessionService.test.ts)
// ---------------------------------------------------------------------------

class FakeAgentRegistry implements IAcpAgentRegistry {
  declare readonly _serviceBrand: undefined
  list() {
    return [{ id: 'fake', name: 'Fake Agent', command: '/x', args: [] }]
  }
  allAgentIds(): readonly string[] {
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
  readonly newSessionCalls: NewSessionRequest[] = []

  constructor(private readonly _agentSessionId: string) {}

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
    return Promise.resolve({ sessionId: this._agentSessionId } as unknown as NewSessionResponse)
  }

  prompt(_params: PromptRequest): Promise<PromptResponse> {
    return Promise.resolve({ stopReason: 'end_turn' } as unknown as PromptResponse)
  }

  cancel(_params: CancelNotification): Promise<void> {
    return Promise.resolve()
  }

  setSessionConfigOption(
    _params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return Promise.resolve({} as unknown as SetSessionConfigOptionResponse)
  }

  loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }

  authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: Array<{ disposed: boolean }> = []
  private _agentSeq = 0
  private _sink: IAcpClientNotificationSink | undefined

  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }

  drainAll(): void {}

  async connect(_agentId: string): Promise<IAcpClientConnection> {
    const sink = this._sink
    if (!sink) throw new Error('FakeAcpClientService.connect: sink not installed')
    const agentSessionId = `agent-${++this._agentSeq}`
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(agentSessionId)
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
    void agentConn
    const record = { disposed: false }
    this.connected.push(record)
    return {
      conn: clientConn,
      initializeResult,
      attachSession: (): void => {},
      dispose: (): void => {
        record.disposed = true
        void pair.clientStream.writable.close().catch(() => {})
        void pair.agentStream.writable.close().catch(() => {})
      },
    }
  }
}

function makeHistory() {
  return new AcpSessionHistoryService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
    FAKE_URI_IDENTITY,
  )
}

function makeAgentDefaults() {
  return new AcpAgentDefaultsService(
    new FakeStorage(),
    new FakeWorkspaceService(),
    new NoopTelemetryService(),
    new StubLoggerService(),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpSessionService — onDidCloseSession', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  beforeEach(() => {
    client = new FakeAcpClientService()
    svc = new AcpSessionService(
      client,
      new FakeAgentRegistry(),
      new FakeWorkspaceService(),
      new ConfigurationService(),
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
      FAKE_URI_IDENTITY,
      new AcpCompactionStatsService(
        new FakeStorage(),
        new NoopTelemetryService(),
        new StubLoggerService(),
      ),
    )
  })

  afterEach(() => {
    svc.dispose()
  })

  it('fires onDidCloseSession with the closed session id', async () => {
    const session = await svc.createSession()
    const fired: string[] = []
    svc.onDidCloseSession((id) => fired.push(id))

    await svc.closeSession(session.id)

    expect(fired).toEqual([session.id])
  })

  it('does not fire onDidCloseSession for an unknown session id', async () => {
    await svc.createSession()
    const fired: string[] = []
    svc.onDidCloseSession((id) => fired.push(id))

    await svc.closeSession('nonexistent-session-id')

    expect(fired).toHaveLength(0)
  })

  it('fires onDidCloseSession for each session closed independently', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    const fired: string[] = []
    svc.onDidCloseSession((id) => fired.push(id))

    await svc.closeSession(a.id)
    await svc.closeSession(b.id)

    expect(fired).toEqual([a.id, b.id])
  })
})
