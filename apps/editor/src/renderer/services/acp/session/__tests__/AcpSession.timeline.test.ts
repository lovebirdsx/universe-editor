/*---------------------------------------------------------------------------------------------
 *  Tests for the unified chat timeline maintained by AcpSession. Drives the
 *  facade with the same FakeAcpClientService + StubAgent harness used by
 *  AcpSessionService.test.ts so we exercise the real session/update routing
 *  path without touching the SDK wire.
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
import { AcpCompactionStatsService } from '../acpCompactionStats.js'
import { AcpSessionHistoryService } from '../acpSessionHistory.js'
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
  type IAcpClientConnection,
  type IAcpClientNotificationSink,
} from '../../acpClientService.js'
import type { IAcpAgentRegistry } from '../../acpAgentRegistry.js'
import type { IAcpPermissionHandler } from '../../acpPermissionHandler.js'
import { createInMemoryAcpPair } from '../../testing/inMemoryAcpPair.js'

const FAKE_URI_IDENTITY = new UriIdentityService('linux')

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
    FAKE_URI_IDENTITY,
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
  agentCapabilities?: Record<string, unknown>
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
      agentCapabilities: this._opts.agentCapabilities ?? {
        loadSession: false,
        promptCapabilities: {},
      },
      authMethods: [],
    } as unknown as InitializeResponse)
  }
  newSession(_p: NewSessionRequest): Promise<NewSessionResponse> {
    return Promise.resolve({ sessionId: this._agentSessionId } as unknown as NewSessionResponse)
  }
  prompt(p: PromptRequest): Promise<PromptResponse> {
    this.promptCalls.push(p)
    const nextError = this._nextPromptError
    this._nextPromptError = undefined
    if (nextError !== undefined) return Promise.reject(nextError)
    if (this._opts.promptHangs) return new Promise<never>(() => {})
    return Promise.resolve({ stopReason: 'end_turn' } as unknown as PromptResponse)
  }
  /** Reject only the next prompt() call — used to land an `[error]` sentinel. */
  private _nextPromptError: Error | undefined
  rejectNextPrompt(err: Error): void {
    this._nextPromptError = err
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
  killConnectionFor(): void {}
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
  changeTracker: StubSessionChangeTracker = new StubSessionChangeTracker(),
): AcpSessionService {
  const notification = new StubNotificationService()
  const telemetry = new NoopTelemetryService() as ITelemetryService
  const history = makeHistory()
  const agentDefaults = makeAgentDefaults()
  return new AcpSessionService(
    client,
    new FakeAgentRegistry(),
    new FakeWorkspaceService(),
    config ?? new ConfigurationService(),
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
      changeTracker,
      new StubSessionTitleService(),
      new AcpCompactionStatsService(
        new FakeStorage(),
        new NoopTelemetryService(),
        new StubLoggerService(),
      ),
    ),
    new StubFileService(),
    new StubExtensionMcpServersService(),
    new StubMcpServerEnablementService(),
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

  it('interleaves message / tool_call slots in arrival order; plan stays off the timeline', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
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
    // Once tool tcB seals the 'hello ' message, a later agent_message_chunk no
    // longer merges back into it — it opens a fresh card appended at the end.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'world' },
      },
    })

    // Plan is rendered as a sticky bar, not a timeline slot.
    const kinds = s.timeline.get().map((it) => it.kind)
    expect(kinds).toEqual(['toolCall', 'message', 'toolCall', 'message'])
    expect(s.plan.get().map((e) => e.content)).toEqual(['first plan'])
    // The pre-tool message is sealed and keeps only its own chunk.
    const firstMessage = s.timeline.get()[1]!
    if (firstMessage.kind !== 'message') throw new Error('unreachable')
    expect(firstMessage.message.text).toBe('hello ')
    expect(firstMessage.message.streaming).toBe(false)
    // The post-tool chunk is its own trailing card, still streaming.
    const lastMessage = s.timeline.get()[3]!
    if (lastMessage.kind !== 'message') throw new Error('unreachable')
    expect(lastMessage.message.text).toBe('world')
    expect(lastMessage.message.streaming).toBe(true)
  })

  it('a thought after tool calls opens a fresh card at the end', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'first thought' },
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
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'second thought' },
      },
    })

    const timeline = s.timeline.get()
    expect(timeline.map((it) => it.kind)).toEqual(['message', 'toolCall', 'toolCall', 'message'])
    const thoughts = timeline
      .map((it) => (it.kind === 'message' ? it.message : null))
      .filter((m): m is NonNullable<typeof m> => m !== null)
    expect(thoughts.map((m) => m.role)).toEqual(['thought', 'thought'])
    expect(thoughts.map((m) => m.text)).toEqual(['first thought', 'second thought'])
  })

  it('tool_call_update keeps the slot at its original index', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
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

  it('folds codex-acp out-of-band terminal output into the execute card text', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    // The fork starts an execute tool call whose `content` carries only a
    // `terminal` placeholder — the real output streams via `_meta` deltas.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'term-1',
        title: 'ls -la',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'term-1' }],
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term-1',
        _meta: { terminal_output_delta: { data: 'line1\n', terminal_id: 'term-1' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term-1',
        _meta: { terminal_output_delta: { data: 'line2\n', terminal_id: 'term-1' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term-1',
        status: 'completed',
        _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: 'term-1' } },
      },
    })

    const slot = s.timeline.get().find((it) => it.kind === 'toolCall' && it.id === 'term-1')
    if (!slot || slot.kind !== 'toolCall') throw new Error('expected execute toolCall')
    // Deltas accumulate; the placeholder never leaks into the body.
    expect(slot.call.text).toBe('line1\nline2\n')
    expect(slot.call.text).not.toContain('[terminal:')
    expect(slot.call.status).toBe('completed')
  })

  it('a full terminal_output snapshot replaces accumulated deltas', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'term-2',
        title: 'echo hi',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'term-2' }],
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term-2',
        _meta: { terminal_output_delta: { data: 'partial', terminal_id: 'term-2' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term-2',
        status: 'completed',
        _meta: { terminal_output: { data: 'full output\n', terminal_id: 'term-2' } },
      },
    })

    const slot = s.timeline.get().find((it) => it.kind === 'toolCall' && it.id === 'term-2')
    if (!slot || slot.kind !== 'toolCall') throw new Error('expected execute toolCall')
    expect(slot.call.text).toBe('full output\n')
  })

  it('plan updates land on the plan observable, not the timeline', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
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

    // Only the tool call is on the timeline; plan replaced in place on its own observable.
    const timeline = s.timeline.get()
    expect(timeline.map((it) => it.kind)).toEqual(['toolCall'])
    expect(s.plan.get().map((e) => e.content)).toEqual(['v2-a', 'v2-b'])
  })

  it('marks a streaming message as streaming:true mid-turn and false after the turn ends', async () => {
    // promptHangs keeps the turn open so chunks land while streaming is in flight.
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    await s.whenConnected()
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

  it('dispatches attached images as leading image blocks and shows them on the user message', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const promptPromise = s.sendPrompt('look', undefined, undefined, [
      { id: 'i1', mimeType: 'image/png', dataBase64: 'AAA', byteSize: 3 },
    ])
    await new Promise((r) => setTimeout(r, 10))

    expect(conn.agent.promptCalls).toHaveLength(1)
    const blocks = conn.agent.promptCalls[0]!.prompt
    // Image leads, then the text block.
    expect(blocks[0]).toEqual({ type: 'image', data: 'AAA', mimeType: 'image/png' })
    expect(blocks.some((b) => b.type === 'text' && b.text === 'look')).toBe(true)

    // The user message on the timeline carries the image block too.
    const userMsg = s.timeline
      .get()
      .flatMap((it) => (it.kind === 'message' ? [it.message] : []))
      .find((m) => m.role === 'user')
    expect(userMsg?.blocks.some((b) => b.type === 'image')).toBe(true)

    await s.cancelTurn()
    await promptPromise
  })

  it('a cancel retracts the just-sent user message from the timeline', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    await s.whenConnected()

    const promptPromise = s.sendPrompt('please cancel me')
    await new Promise((r) => setTimeout(r, 5))
    await s.cancelTurn()
    await promptPromise

    // No trace of the cancelled turn: no '[cancelled]' sentinel, and the sent
    // user message is retracted — the restore event carries the draft back to
    // the input box, so the timeline would otherwise duplicate it.
    const slots = s.timeline.get().filter((it) => it.kind === 'message')
    expect(slots).toHaveLength(0)
    expect(s.messages.get()).toHaveLength(0)
  })

  it('only the active streaming message carries streaming:true across role switches', async () => {
    svc.dispose()
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
    const s = await svc.createSession()
    await s.whenConnected()
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

  it('blank thought chunks never produce a message slot', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    for (const text of ['', '   ', '\n\t']) {
      conn.sink.onSessionUpdate({
        sessionId: 'agent-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
      })
    }

    const messages = s.timeline.get().filter((it) => it.kind === 'message')
    expect(messages).toHaveLength(0)
  })

  it('a blank thought followed by an agent message leaves only the agent card', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '   ' } },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    })

    const messages = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? it.message : null))
      .filter((m): m is NonNullable<typeof m> => m !== null)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('agent')
    expect(messages[0]!.text).toBe('answer')
  })

  it('a blank chunk inside an active thought stream preserves inter-word spacing', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    for (const text of ['a', '', ' b']) {
      conn.sink.onSessionUpdate({
        sessionId: 'agent-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
      })
    }

    const thoughts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? it.message : null))
      .filter((m): m is NonNullable<typeof m> => m !== null && m.role === 'thought')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.text).toBe('a b')
  })

  it('a leading blank thought chunk is skipped but later content still opens a card', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'real' } },
    })

    const thoughts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? it.message : null))
      .filter((m): m is NonNullable<typeof m> => m !== null && m.role === 'thought')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.text).toBe('real')
    expect(thoughts[0]!.streaming).toBe(true)
  })

  it('routes sub-agent updates into the parent tool call children', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcParent',
        title: 'Task',
        kind: 'other',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'sub thinking ' },
        _meta: { claudeCode: { parentToolUseId: 'tcParent' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'more' },
        _meta: { claudeCode: { parentToolUseId: 'tcParent' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcChild',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        _meta: { claudeCode: { parentToolUseId: 'tcParent' } },
      },
    })

    // Only the parent is on the top-level timeline; children fold inside it.
    const timeline = s.timeline.get()
    expect(timeline.map((it) => it.kind)).toEqual(['toolCall'])
    const parent = timeline[0]!
    if (parent.kind !== 'toolCall') throw new Error('expected toolCall')
    expect(parent.id).toBe('tcParent')
    const children = parent.call.children ?? []
    expect(children.map((c) => c.kind)).toEqual(['message', 'toolCall'])
    const childMsg = children[0]!
    if (childMsg.kind !== 'message') throw new Error('expected message')
    // Consecutive child chunks merge into one message.
    expect(childMsg.message.text).toBe('sub thinking more')
    const childTool = children[1]!
    if (childTool.kind !== 'toolCall') throw new Error('expected toolCall')
    expect(childTool.id).toBe('tcChild')
    // The child tool call never leaks into the top-level toolCalls observable.
    expect(s.toolCalls.get().map((t) => t.id)).toEqual(['tcParent'])
  })

  it('breaks the child message merge when a child tool call interleaves', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    const child = <T extends object>(u: T) => ({
      ...u,
      _meta: { claudeCode: { parentToolUseId: 'tcP' } },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcP',
        title: 'Task',
        kind: 'other',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }),
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: child({
        sessionUpdate: 'tool_call',
        toolCallId: 'tcInner',
        title: 'Read',
        kind: 'read',
        status: 'completed',
      }),
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } }),
    })

    const parent = s.timeline.get()[0]!
    if (parent.kind !== 'toolCall') throw new Error('expected toolCall')
    const children = parent.call.children ?? []
    // The tool call between the two chunks opens a fresh trailing message.
    expect(children.map((c) => c.kind)).toEqual(['message', 'toolCall', 'message'])
    const first = children[0]!
    const last = children[2]!
    if (first.kind !== 'message' || last.kind !== 'message') throw new Error('expected messages')
    expect(first.message.text).toBe('a')
    expect(last.message.text).toBe('b')
  })

  it('merges sub-agent children that arrive before their parent tool call', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    // Child message arrives first (out-of-order); parent lands afterwards.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'early child' },
        _meta: { claudeCode: { parentToolUseId: 'tcLate' } },
      },
    })
    expect(s.timeline.get()).toHaveLength(0)
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcLate',
        title: 'Task',
        kind: 'other',
        status: 'in_progress',
      },
    })

    const parent = s.timeline.get()[0]!
    if (parent.kind !== 'toolCall') throw new Error('expected toolCall')
    const children = parent.call.children ?? []
    expect(children).toHaveLength(1)
    const c = children[0]!
    if (c.kind !== 'message') throw new Error('expected message')
    expect(c.message.text).toBe('early child')
  })

  it('keeps sub-agent children across a parent tool_call_update', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcP',
        title: 'Task',
        kind: 'other',
        status: 'in_progress',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'child output' },
        _meta: { claudeCode: { parentToolUseId: 'tcP' } },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tcP', status: 'completed' },
    })

    const parent = s.timeline.get()[0]!
    if (parent.kind !== 'toolCall') throw new Error('expected toolCall')
    expect(parent.call.status).toBe('completed')
    const children = parent.call.children ?? []
    expect(children).toHaveLength(1)
    const c = children[0]!
    if (c.kind !== 'message') throw new Error('expected message')
    expect(c.message.text).toBe('child output')
  })

  it('re-attaches a child tool_call_update that drops parentToolUseId (PostToolUse hook)', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcParent',
        title: 'Task',
        kind: 'other',
        status: 'in_progress',
      },
    })
    // Child tool call lands inside the parent, still pending.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcChild',
        title: 'Edit',
        kind: 'edit',
        status: 'pending',
        _meta: { claudeCode: { parentToolUseId: 'tcParent' } },
      },
    })
    // PostToolUse hook completes it but omits parentToolUseId (the bug trigger).
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tcChild', status: 'completed' },
    })

    // No orphan top-level slot — only the parent is on the timeline.
    const timeline = s.timeline.get()
    expect(timeline.map((it) => it.id)).toEqual(['tcParent'])
    expect(s.toolCalls.get().map((t) => t.id)).toEqual(['tcParent'])

    const parent = timeline[0]!
    if (parent.kind !== 'toolCall') throw new Error('expected toolCall')
    const children = parent.call.children ?? []
    expect(children).toHaveLength(1)
    const childTool = children[0]!
    if (childTool.kind !== 'toolCall') throw new Error('expected toolCall')
    expect(childTool.id).toBe('tcChild')
    // The hook update re-attached and flipped status; title/kind survive too.
    expect(childTool.call.status).toBe('completed')
    expect(childTool.call.kind).toBe('edit')
    expect(childTool.call.title).toBe('Edit')
  })

  it('records Codex Edit diff content as a session file change', async () => {
    svc.dispose()
    const tracker = new StubSessionChangeTracker()
    svc = makeService(client, undefined, tracker)
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'codex-edit',
        title: 'Edit /work/new.ts',
        kind: 'edit',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: '/work/new.ts',
            oldText: null,
            newText: 'alpha\nbeta',
          },
        ],
      },
    })

    expect(tracker.records).toHaveLength(1)
    expect(tracker.records[0]).toMatchObject({
      sessionId: 'agent-1',
      path: '/work/new.ts',
      toolCallId: 'codex-edit',
      created: true,
    })
    expect(tracker.records[0]?.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ['+alpha', '+beta'],
      },
    ])
  })

  it('suppressReplayToTimeline drops replay updates until endHistoryReplay resets it', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    s.suppressReplayToTimeline()

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'baseline message' },
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tcBaseline',
        title: 'Baseline',
        kind: 'read',
        status: 'completed',
      },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'baseline plan', priority: 'high', status: 'pending' }],
      },
    })

    // Nothing replayed lands on the timeline / plan / toolCalls.
    expect(s.timeline.get()).toEqual([])
    expect(s.plan.get()).toEqual([])
    expect(s.toolCalls.get()).toEqual([])

    s.endHistoryReplay()

    // Post-replay traffic flows again.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fresh message' },
      },
    })
    expect(s.timeline.get().map((it) => it.kind)).toEqual(['message'])
    const item = s.timeline.get()[0]!
    if (item.kind !== 'message') throw new Error('expected message')
    expect(item.message.text).toBe('fresh message')
  })

  it('anchor lifts suppression at the boundary user chunk, keeping the side task’s own turns', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    s.suppressReplayToTimeline('anchor-msg')

    // Baseline: a user message + agent reply + tool call, all before the anchor.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'baseline user' },
        messageId: 'baseline-msg',
      } as never,
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'baseline agent' },
      },
    })

    // Boundary: the side task's first own prompt — lifts the suppression.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'side-task first prompt' },
        messageId: 'anchor-msg',
      } as never,
    })
    // The side task's own turn after the anchor must land.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'side-task answer' },
      },
    })

    const texts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? `${it.message.role}:${it.message.text}` : ''))
    expect(texts).toEqual(['user:side-task first prompt', 'agent:side-task answer'])

    s.endHistoryReplay()
  })

  it('stamps a replayed user chunk matching the continuation sentinel as autoRetry', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '继续' },
        messageId: 'cont-1',
      } as never,
    })
    // An agent reply seals the user stream so the next user chunk opens a fresh
    // message instead of merging.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'reply' },
      },
    })
    s.endHistoryReplay()

    // The same text outside the replay window is a genuinely typed message.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '继续' },
        messageId: 'live-1',
      } as never,
    })

    const users = s.messages.get().filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ text: '继续', autoRetry: true })
    expect(users[1]!.autoRetry).toBeUndefined()
  })

  it('drops replayed user chunks whose messageId was retracted, plus the trailing interruption marker', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    s.setRetractedMessageIds(['mid-1'])

    // The retracted prompt replays from the transcript — dropped.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'retracted prompt' },
        messageId: 'mid-1',
      } as never,
    })
    // The SDK's trailing interruption marker is a separate user message with its
    // own id — dropped via the one-shot flag armed by the retracted chunk.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Request interrupted by user]' },
        messageId: 'mid-2',
      } as never,
    })
    // The next genuine user message still lands.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'next prompt' },
        messageId: 'mid-3',
      } as never,
    })

    const texts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? `${it.message.role}:${it.message.text}` : ''))
    expect(texts).toEqual(['user:next prompt'])

    s.endHistoryReplay()
  })

  it('consumes the interruption-marker skip on the next user chunk even when it is not the marker', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    s.setRetractedMessageIds(['mid-1'])

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'retracted prompt' },
        messageId: 'mid-1',
      } as never,
    })
    // Agent had already produced output before the cancel, so the transcript's
    // next user message is a genuine reprompt, not the marker — it must land,
    // and the one-shot skip is spent (a later stray marker text then lands too).
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'reprompt' },
        messageId: 'mid-2',
      } as never,
    })

    const texts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? `${it.message.role}:${it.message.text}` : ''))
    expect(texts).toEqual(['user:reprompt'])

    s.endHistoryReplay()
  })

  it('keeps replayed adjacent user messages as separate cards when their anchors differ', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()

    // The interruption marker (anchorless) followed by the re-sent prompt
    // (anchored) must not fuse into one card.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Request interrupted by user]' },
      } as never,
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '继续' },
        messageId: 'mid-next',
      } as never,
    })
    // Two chunks of the SAME persisted message (multi-block prompt) still merge.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'part1 ' },
        messageId: 'mid-multi',
      } as never,
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'part2' },
        messageId: 'mid-multi',
      } as never,
    })

    const texts = s.timeline
      .get()
      .filter((it) => it.kind === 'message')
      .map((it) => (it.kind === 'message' ? `${it.message.role}:${it.message.text}` : ''))
    expect(texts).toEqual(['user:[Request interrupted by user]', 'user:继续', 'user:part1 part2'])

    s.endHistoryReplay()
  })

  it('config_option_update still applies while replay is suppressed', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    s.beginHistoryReplay()
    s.suppressReplayToTimeline()

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'plan',
            options: [
              { value: 'plan', name: 'Plan' },
              { value: 'default', name: 'Default' },
            ],
          },
        ],
      } as never,
    })

    const mode = s.configOptions.get().find((o) => o.id === 'mode')
    expect(mode?.currentValue).toBe('plan')

    s.endHistoryReplay()
  })
})

describe('AcpSession.timeline — batched/immediate atomicity', () => {
  let svc: AcpSessionService
  let client: FakeAcpClientService

  beforeEach(() => {
    // Hanging prompt so the turn stays 'running' and a mid-stream sentinel
    // (`[error]`) can be appended while a chunk batch is still pending.
    client = new FakeAcpClientService({ stubOptions: { promptHangs: true } })
    svc = makeService(client)
  })

  afterEach(() => {
    svc.dispose()
  })

  it('never exposes messages torn from timeline when a sentinel lands mid-stream', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    // Observe both lanes together; record any frame where the trailing message
    // is present in one lane but not the other (the torn intermediate state the
    // 16ms batcher must prevent). Attached before any prompt so it also catches
    // the user-message append, which runs with no batch pending.
    let torn = 0
    const stop = autorun((r) => {
      const msgs = s.messages.read(r)
      const tl = s.timeline.read(r)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg === undefined) return
      const inTimeline = tl.some((it) => it.kind === 'message' && it.id === lastMsg.id)
      if (!inTimeline) torn++
    })

    const promptPromise = s.sendPrompt('go')

    // Open a pending chunk batch, then append an `[error]` sentinel (the agent
    // fails the prompt) while that batch is still pending — the prior bug set
    // messages and timeline with separate immediate notifications, tearing them.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
    })
    conn.agent.rejectNextPrompt(new Error('agent crashed'))
    await promptPromise

    expect(torn).toBe(0)
    // Final state is consistent: the error sentinel is in both lanes. (The
    // agent-side rejection crosses the wire SDK-wrapped as 'Internal error'.)
    const msgs = s.messages.get()
    const last = msgs[msgs.length - 1]!
    expect(last.text).toMatch(/^\[error\] /)
    expect(s.timeline.get().some((it) => it.kind === 'message' && it.id === last.id)).toBe(true)
    stop.dispose()
  })

  it('appending a mid-stream sentinel does not throw the dev torn-state guard', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!
    const promptPromise = s.sendPrompt('go')
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk' } },
    })
    // _appendMessage runs while the chunk batch is pending; it must commit the
    // batch rather than tripping the immediate-set guard.
    conn.agent.rejectNextPrompt(new Error('agent crashed'))
    await promptPromise
  })

  it('merges sub-agent stats onto the parent Task card and prices Claude token tallies', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    // A Task tool call lands, then a bare `_meta`-only update carries the running
    // sub-agent tally (as the claude fork forwards it per sub-agent message).
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Explore', kind: 'other' },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task-1',
        _meta: {
          '_universe/subagentStats': {
            model: 'claude-sonnet-5',
            subagentType: 'general-purpose',
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        },
      },
    })

    const slot = s.timeline.get().find((it) => it.kind === 'toolCall' && it.id === 'task-1')
    if (!slot || slot.kind !== 'toolCall') throw new Error('expected task card')
    const stats = slot.call.subagentStats
    expect(stats?.model).toBe('claude-sonnet-5')
    expect(stats?.inputTokens).toBe(1_000_000)
    // 1M input @ $3 + 1M output @ $15 = $18 (sonnet pricing).
    expect(stats?.costUSD).toBeCloseTo(18, 5)
    // The bare _meta update must not clobber the card's title/kind.
    expect(slot.call.title).toBe('Explore')
  })

  it('carries the sub-agent tally forward across updates that omit it', async () => {
    const s = await svc.createSession()
    await s.whenConnected()
    const conn = client.connected[0]!

    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'T', kind: 'other' },
    })
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task-1',
        _meta: {
          '_universe/subagentStats': {
            model: 'claude-opus-4-8',
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        },
      },
    })
    // A later status-only update (no _meta) must not drop the tally.
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'task-1', status: 'completed' },
    })

    const slot = s.timeline.get().find((it) => it.kind === 'toolCall' && it.id === 'task-1')
    if (!slot || slot.kind !== 'toolCall') throw new Error('expected task card')
    expect(slot.call.subagentStats?.model).toBe('claude-opus-4-8')
    expect(slot.call.status).toBe('completed')
    // A settled top-level card records a frozen duration.
    expect(slot.call.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('AcpSession — universe capabilities from initialize _meta', () => {
  let svc: AcpSessionService | undefined

  afterEach(() => {
    svc?.dispose()
    svc = undefined
  })

  // The private file-rollback observable drives rewindTo's client-side restore
  // branch; read it directly rather than widening the public surface for a test.
  function filesRolledBackByAgent(s: object): boolean {
    return (s as { _filesRolledBackByAgent: IObservable<boolean> })._filesRolledBackByAgent.get()
  }

  // The initialize round-trip over the in-memory wire settles a tick after
  // whenConnected() (which resolves on newSession). Poll the derived observable
  // rather than racing that microtask.
  async function connectedSession(caps: Record<string, unknown>) {
    const client = new FakeAcpClientService({ stubOptions: { agentCapabilities: caps } })
    svc = makeService(client)
    const s = await svc.createSession()
    await s.whenConnected()
    await new Promise((r) => setTimeout(r, 50))
    return s
  }

  it('lights up rewindSupported when the fork advertises a rewind block', async () => {
    const s = await connectedSession({
      loadSession: false,
      promptCapabilities: {},
      _meta: { 'universe-editor/capabilities': { rewind: { filesRolledBackByAgent: true } } },
    })
    expect(s.rewindSupported.get()).toBe(true)
  })

  it('leaves rewindSupported off when no capability block is present', async () => {
    const s = await connectedSession({ loadSession: false, promptCapabilities: {} })
    expect(s.rewindSupported.get()).toBe(false)
  })

  it('treats a fork that rolls files back itself as agent-side (no client-side rollback)', async () => {
    const s = await connectedSession({
      loadSession: false,
      promptCapabilities: {},
      _meta: { 'universe-editor/capabilities': { rewind: { filesRolledBackByAgent: true } } },
    })
    // rewindTo skips the client-side file restore when the agent owns rollback.
    expect(s.rewindSupported.get()).toBe(true)
    expect(filesRolledBackByAgent(s)).toBe(true)
  })

  it('treats a fork that leaves files untouched as client-side rollback', async () => {
    const s = await connectedSession({
      loadSession: false,
      promptCapabilities: {},
      _meta: { 'universe-editor/capabilities': { rewind: { filesRolledBackByAgent: false } } },
    })
    expect(s.rewindSupported.get()).toBe(true)
    expect(filesRolledBackByAgent(s)).toBe(false)
  })
})
