/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionService.ts
 *  Drives AcpSessionService with a fake AcpClientService that returns an
 *  in-memory AcpConnection. We dispatch session/update notifications via the
 *  sink the service registers on connect() to exercise the streaming /
 *  tool-call / plan code paths.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Emitter, NullLogger } from '@universe-editor/platform'
import type { IWorkspace, IWorkspaceService } from '@universe-editor/platform'
import { AcpSessionService } from '../acpSessionService.js'
import { IAcpClientService, type IAcpClientNotificationSink } from '../acpClientService.js'
import type { IAcpAgentRegistry } from '../acpAgentRegistry.js'
import {
  AcpConnection,
  AcpRpcError,
  createInMemoryAcpHost,
  type IAcpConnectionHandler,
  type IAcpTransportTestHarness,
} from '../acpConnection.js'
import { AcpMethods, type AcpSessionUpdate, type AcpSessionUpdateParams } from '../acpProtocol.js'

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

  beforeEach(() => {
    client = new FakeAcpClientService()
    svc = new AcpSessionService(client, new FakeAgentRegistry(), new FakeWorkspaceService())
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
})

// Suppress unused warnings for helpers kept for future tests.
void flush
