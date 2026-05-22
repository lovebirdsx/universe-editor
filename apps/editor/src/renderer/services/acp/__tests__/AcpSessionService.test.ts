/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionService.ts
 *  Drives AcpSessionService with a fake AcpClientService that returns an
 *  in-memory AcpConnection. We dispatch session/update notifications via the
 *  sink the service registers on connect() to exercise the streaming /
 *  tool-call / plan code paths.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  autorun,
  ConfigurationService,
  Emitter,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  observableValue,
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
  type AcpSessionUpdate,
  type AcpSessionUpdateParams,
} from '../acpProtocol.js'

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
  autoApproveResult: AcpRequestPermissionResult | undefined = undefined
  readonly persisted: string[] = []
  tryAutoApprove(_params: AcpRequestPermissionParams): AcpRequestPermissionResult | undefined {
    return this.autoApproveResult
  }
  persistAllow(kind: string): void {
    this.persisted.push(kind)
  }
}

/**
 * Captures the sink + connection so tests can inject inbound traffic.
 */
interface ConnectedSession {
  readonly sink: IAcpClientNotificationSink
  readonly harness: IAcpTransportTestHarness
  readonly handler: IAcpConnectionHandler
  readonly connection: AcpConnection
}

class FakeAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  /** One ConnectedSession per connect() call, in order. */
  readonly connected: ConnectedSession[] = []
  private _agentSeq = 0
  /** Optional override: peer requests to perform after `initialize` + `new` succeed. */
  postNewSessionHook: ((conn: ConnectedSession) => void) | undefined

  async connect(_agentId: string, sink: IAcpClientNotificationSink): Promise<AcpConnection> {
    const agentSessionId = `agent-${++this._agentSeq}`
    const harness = createInMemoryAcpHost()
    const handler: IAcpConnectionHandler = {
      onRequest: () => Promise.reject(new AcpRpcError('not implemented', -32601)),
      onNotification: (_m, p) => sink.onSessionUpdate(p as AcpSessionUpdateParams),
    }
    const conn = new AcpConnection(harness.host, harness.handle, handler, new NullLogger())

    // Auto-respond to the two outbound requests AcpSessionService issues
    // during createSession: `initialize` and `session/new`.
    const ackInitial = (rawLines: readonly string[]): void => {
      for (const line of rawLines) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as { id?: unknown; method?: string }
        if (typeof msg.id !== 'number' && typeof msg.id !== 'string') continue
        if (msg.method === AcpMethods.Initialize) {
          harness.inject(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: 1 },
            }) + '\n',
          )
        } else if (msg.method === AcpMethods.NewSession) {
          harness.inject(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { sessionId: agentSessionId },
            }) + '\n',
          )
        }
      }
    }

    // Poll synchronously after a microtask flush: the test calls
    // createSession() which awaits two requests; each write goes into
    // harness.written(). We watch the array and feed responses back.
    let lastSeen = 0
    const interval: NodeJS.Timeout = setInterval(() => {
      const writes = harness.written()
      if (writes.length > lastSeen) {
        const newLines = writes.slice(lastSeen)
        lastSeen = writes.length
        for (const w of newLines) ackInitial(w.split('\n'))
      }
    }, 1)

    const session: ConnectedSession = { sink, harness, handler, connection: conn }
    this.connected.push(session)

    // Auto-stop the response pump once the test disposes the connection.
    const cleanup = (): void => clearInterval(interval)
    conn.onExit(cleanup)
    return conn
  }
}

async function flush(): Promise<void> {
  // Allow microtasks + the 1ms ack interval to run.
  await new Promise((r) => setTimeout(r, 10))
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

    const chunkA: AcpSessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello A' },
    }
    const chunkB: AcpSessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello B' },
    }
    connA.sink.onSessionUpdate({ sessionId: 'agent-1', update: chunkA })
    connB.sink.onSessionUpdate({ sessionId: 'agent-2', update: chunkB })

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
      // initial run counts as 1
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
      // Value is updated synchronously — readers see the latest array...
      expect(
        s.messages
          .get()
          .map((m) => m.text)
          .join(''),
      ).toBe('c0c1c2c3c4c5c6c7c8c9')
      // ...but observers have NOT fired yet (still within the open batch).
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
        kind: 'fs',
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
        content: [{ type: 'text', text: 'output' }],
      },
    })
    calls = s.toolCalls.get()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe('completed')
    expect(calls[0]?.text).toBe('output')
    expect(calls[0]?.title).toBe('Read file')
  })

  it('publishes plan entries verbatim', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!
    conn.sink.onSessionUpdate({
      sessionId: 'agent-1',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'step one', priority: 'high' }, { content: 'step two' }],
      },
    })
    const plan = s.plan.get()
    expect(plan).toEqual([{ content: 'step one', priority: 'high' }, { content: 'step two' }])
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

  it('cancelTurn writes a session/cancel notification to stdin', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!
    const before = conn.harness.written().length
    await s.cancelTurn()
    const writes = conn.harness.written()
    const lastFrames = writes.slice(before).join('')
    expect(lastFrames).toContain('"method":"session/cancel"')
    expect(lastFrames).toContain('"sessionId":"agent-1"')
  })

  it('getById returns undefined for unknown ids', async () => {
    expect(svc.getById('nope')).toBeUndefined()
    const a = await svc.createSession()
    expect(svc.getById(a.id)?.id).toBe(a.id)
  })

  it('cancelTurn aborts the pending session/prompt locally even if agent never responds', async () => {
    const s = await svc.createSession()
    const conn = client.connected[0]!
    // Swap the connection's peer-side handler so initialize/session_new keep
    // answering but session/prompt never resolves.
    const before = conn.harness.written().length
    const promptPromise = s.sendPrompt('hi there')
    // Give the prompt write time to land on the wire.
    await new Promise((r) => setTimeout(r, 10))
    const writesAfter = conn.harness.written().slice(before).join('')
    expect(writesAfter).toContain('"method":"session/prompt"')
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
      toolCall: { toolCallId: 'tc1', kind: 'fs.read' },
      options: [{ optionId: 'opt1', name: 'Allow', kind: 'allow_once' }],
    })
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt1' } })
    expect(s.pendingPermission.get()).toBeUndefined()
  })

  it('routes interactive permission requests to the matching session and resolves via the card', async () => {
    const a = await svc.createSession()
    const b = await svc.createSession()
    void a // satisfy TS
    const pendingPromise = svc.onRequestPermission({
      sessionId: 'agent-2',
      toolCall: { toolCallId: 'tc2', kind: 'fs.write', title: 'Edit src/foo.ts' },
      options: [
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    // Card lands on B, not A.
    await new Promise((r) => setTimeout(r, 0))
    expect(a.pendingPermission.get()).toBeUndefined()
    const pending = b.pendingPermission.get()
    expect(pending?.title).toBe('Edit src/foo.ts')
    pending!.resolve('always')
    const result = await pendingPromise
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
    expect(b.pendingPermission.get()).toBeUndefined()
    expect(permission.persisted).toEqual(['fs.write'])
  })

  it('returns cancelled when the user denies via the card', async () => {
    const b = await svc.createSession()
    const promise = svc.onRequestPermission({
      sessionId: 'agent-1',
      toolCall: { toolCallId: 'tc3' },
      options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    })
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
    })
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
    })
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

class TimeoutAcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined
  readonly harnesses: IAcpTransportTestHarness[] = []
  async connect(_agentId: string, _sink: IAcpClientNotificationSink): Promise<AcpConnection> {
    const harness = createInMemoryAcpHost()
    this.harnesses.push(harness)
    const handler: IAcpConnectionHandler = {
      onRequest: () => Promise.reject(new AcpRpcError('not implemented', -32601)),
      onNotification: () => {},
    }
    // Crucially: do NOT auto-respond to initialize. The connection will hang.
    return new AcpConnection(harness.host, harness.handle, handler, new NullLogger())
  }
}

describe('AcpSessionService — startup timeout', () => {
  it('rejects createSession when the agent never answers initialize', async () => {
    const client = new TimeoutAcpClientService()
    const config = new ConfigurationService()
    // Cut the timeout to keep the test fast.
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
    )
    await expect(svc.createSession()).rejects.toThrow(/timed out/)
    svc.dispose()
  })
})

// Suppress unused warnings for helpers kept for future tests.
void flush
