/*---------------------------------------------------------------------------------------------
 *  Tests for the unified chat timeline maintained by AcpSession. Drives the
 *  facade with the same FakeAcpClientService + StubAgent harness used by
 *  AcpSessionService.test.ts so we exercise the real session/update routing
 *  path without touching the SDK wire.
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

const FAKE_HOST: IHostService = { platform: 'linux' } as IHostService

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
  notify(_opts: { severity: unknown; message: string }): INotificationHandle {
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
  tryAutoApprove(_p: RequestPermissionRequest): RequestPermissionResponse | undefined {
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

interface StubAgentOptions {
  promptHangs?: boolean
}

class StubAgent implements Agent {
  readonly promptCalls: PromptRequest[] = []
  constructor(
    private readonly _agentSessionId: string,
    private readonly _opts: StubAgentOptions = {},
  ) {}
  initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    return Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    } as unknown as InitializeResponse)
  }
  newSession(_p: NewSessionRequest): Promise<NewSessionResponse> {
    return Promise.resolve({ sessionId: this._agentSessionId } as unknown as NewSessionResponse)
  }
  prompt(p: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(p)
    if (this._opts.promptHangs) return new Promise<never>(() => {})
    return Promise.resolve({ stopReason: 'end_turn' } as unknown as PromptResponse)
  }
  cancel(_p: CancelNotification): Promise<void> {
    return Promise.resolve()
  }
  setSessionConfigOption(
    _p: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return Promise.resolve({} as unknown as SetSessionConfigOptionResponse)
  }
  loadSession(_p: LoadSessionRequest): Promise<LoadSessionResponse> {
    return Promise.resolve({} as unknown as LoadSessionResponse)
  }
  authenticate(_p: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    return Promise.resolve()
  }
}

interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly agent: StubAgent
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly connected: ConnectedSession[] = []
  private _agentSeq = 0
  private _sink: IAcpClientNotificationSink | undefined
  constructor(private readonly _opts: { stubOptions?: StubAgentOptions } = {}) {}
  setNotificationSink(sink: IAcpClientNotificationSink): void {
    this._sink = sink
  }
  drainAll(): void {}
  async connect(_agentId: string): Promise<IAcpClientConnection> {
    const sink = this._sink
    if (!sink) throw new Error('FakeAcpClientService.connect: sink not installed')
    const agentSessionId = `agent-${++this._agentSeq}`
    const pair = createInMemoryAcpPair()
    const agent = new StubAgent(agentSessionId, this._opts.stubOptions ?? {})
    const _agentConn = new AgentSideConnection(() => agent, pair.agentStream)
    void _agentConn
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
    this.connected.push({ sink, agent })
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

function makeService(
  client: FakeAcpClientService,
  config?: IConfigurationService,
): AcpSessionService {
  return new AcpSessionService(
    client,
    new FakeAgentRegistry(),
    new FakeWorkspaceService(),
    config ?? new ConfigurationService(),
    new StubNotificationService(),
    new NoopTelemetryService() as ITelemetryService,
    new StubPermissionHandler(),
    new StubProgressService(),
    new StubLoggerService(),
    makeHistory(),
    new FakeStorage(),
    makeAgentDefaults(),
    FAKE_HOST,
  )
}

describe('AcpSession.timeline', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  beforeEach(() => {
    client = new FakeAcpClientService()
    svc = makeService(client)
  })

  afterEach(() => {
    svc.dispose()
  })

  it('interleaves message / tool_call / plan slots in arrival order', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcA',
        title: 'A',
        kind: 'read',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello ' },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcB',
        title: 'B',
        kind: 'edit',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'first plan', priority: 'high', status: 'pending' }],
      },
    })
    // Subsequent agent_message_chunk merges into the existing streaming message
    // rather than producing a new slot — so the trailing kind is still 'plan'.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'world' },
      },
    })

    const kinds = s.timeline.get().map((it) => it.kind)
    expect(kinds).toEqual(['toolCall', 'message', 'toolCall', 'plan'])
    // The merged streaming message has both chunks.
    const messageSlot = s.timeline.get()[1]!
    expect(messageSlot.kind).toBe('message')
    if (messageSlot.kind !== 'message') throw new Error('unreachable')
    expect(messageSlot.message.text).toBe('hello world')
    expect(messageSlot.message.streaming).toBe(true)
  })

  it('tool_call_update keeps the slot at its original index', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcA',
        title: 'A',
        kind: 'read',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcB',
        title: 'B',
        kind: 'edit',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tcA',
        status: 'completed',
      },
    })

    const ids = s.timeline.get().map((it) => (it.kind === 'toolCall' ? it.id : it.kind))
    expect(ids).toEqual(['tcA', 'tcB'])
    const first = s.timeline.get()[0]!
    if (first.kind !== 'toolCall') throw new Error('expected toolCall')
    expect(first.call.status).toBe('completed')
  })

  it('plan slot is anchored at first appearance and replaced in place on update', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'v1', priority: 'medium', status: 'pending' }],
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcA',
        title: 'A',
        kind: 'read',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'v2-a', priority: 'high', status: 'pending' },
          { content: 'v2-b', priority: 'medium', status: 'pending' },
        ],
      },
    })

    const timeline = s.timeline.get()
    expect(timeline.map((it) => it.kind)).toEqual(['plan', 'toolCall'])
    const planSlot = timeline[0]!
    if (planSlot.kind !== 'plan') throw new Error('expected plan')
    expect(planSlot.entries.map((e) => e.content)).toEqual(['v2-a', 'v2-b'])
  })

  it('marks a streaming message as streaming:true mid-turn and false after the turn ends', async () => {
    // promptHangs keeps the turn open so chunks land while streaming is in flight.
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('hi')
    await new Promise((r) => setTimeout(r, 5))

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'part1 ' },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'part2' },
      },
    })

    const midAgent = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? it.message : null))
      .find((m) => m?.role === 'agent')
    expect(midAgent).toBeDefined()
    expect(midAgent?.streaming).toBe(true)
    expect(midAgent?.text).toBe('part1 part2')

    await s.cancelTurn()
    await promptPromise

    const endAgent = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? it.message : null))
      .find((m) => m?.role === 'agent' && m.text === 'part1 part2')
    expect(endAgent).toBeDefined()
    expect(endAgent?.streaming).toBe(false)
  })

  it('user prompt and [cancelled] sentinel messages are never marked streaming', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()

    const promptPromise = s.sendPrompt('please cancel me')
    await new Promise((r) => setTimeout(r, 5))
    await s.cancelTurn()
    await promptPromise

    const slots = s.timeline.get().filter((it) => it.kind === 'message')
    expect(slots.length).toBeGreaterThanOrEqual(2)
    for (const slot of slots) {
      if (slot.kind !== 'message') throw new Error('unreachable')
      expect(slot.message.streaming).toBe(false)
    }
  })

  it('only the active streaming message carries streaming:true across role switches', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('go')
    await new Promise((r) => setTimeout(r, 5))

    const messages = () =>
      s.timeline
        .get()
        .filter((it) => it.kind === 'message')
        .map((it) => (it.kind === 'message' ? it.message : null))
        .filter((m): m is NonNullable<typeof m> => m !== null && m.role !== 'user')

    const expectAtMostOneStreaming = () => {
      const streamingCount = messages().filter((m) => m.streaming).length
      expect(streamingCount).toBeLessThanOrEqual(1)
    }

    // Step 1: thought chunk → thought streaming.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    })
    {
      const thought = messages().find((m) => m.role === 'thought')
      expect(thought?.streaming).toBe(true)
      expectAtMostOneStreaming()
    }

    // Step 2: agent chunk → thought collapses to streaming:false, agent takes over.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer part1' },
      },
    })
    {
      const ms = messages()
      const thought = ms.find((m) => m.role === 'thought')
      const agent = ms.find((m) => m.role === 'agent' && m.text === 'answer part1')
      expect(thought?.streaming).toBe(false)
      expect(agent?.streaming).toBe(true)
      expectAtMostOneStreaming()
    }

    // Step 3: second agent chunk merges into the same agent message.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer part2' },
      },
    })
    {
      const agent = messages().find(
        (m) => m.role === 'agent' && m.text === 'answer part1answer part2',
      )
      expect(agent?.streaming).toBe(true)
      expectAtMostOneStreaming()
    }

    // Step 4: switch back to thought → previous agent message collapses.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'more thinking' },
      },
    })
    {
      const ms = messages()
      const agent = ms.find((m) => m.role === 'agent' && m.text === 'answer part1answer part2')
      const latestThought = [...ms].reverse().find((m) => m.role === 'thought')
      expect(agent?.streaming).toBe(false)
      expect(latestThought?.streaming).toBe(true)
      expectAtMostOneStreaming()
    }

    // Turn cleanup: _flushStream tears down the remaining streaming message.
    await s.cancelTurn()
    await promptPromise
    for (const m of messages()) {
      expect(m.streaming).toBe(false)
    }
  })
})
