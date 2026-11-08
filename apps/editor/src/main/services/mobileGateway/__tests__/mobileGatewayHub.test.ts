import { Emitter, type ILogger } from '@universe-editor/platform'
import type { MobileSessionRef, ServerFrame } from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import type {
  IMobileBridgeService,
  MobileBridgeEvent,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
} from '../../../../shared/ipc/mobileGatewayService.js'
import {
  MAX_BUFFERED_SESSION_BYTES,
  MobileGatewayHub,
  type MobileGatewayHubConnection,
} from '../mobileGatewayHub.js'

const NULL_LOGGER = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogger

class FakeBridge implements IMobileBridgeService {
  declare readonly _serviceBrand: undefined
  readonly startStreaming = vi.fn(async () => {})
  readonly stopStreaming = vi.fn(async () => {})
  readonly listSessions = vi.fn(async () => this.sessions)
  readonly getSnapshot = vi.fn(async (localId: string) => this.snapshots.get(localId))
  readonly getToolCallDetail = vi.fn(async () => this.detail)
  readonly ping = vi.fn(async () => 'pong' as const)

  sessions: MobileBridgeSessionSummary[] = []
  snapshots = new Map<string, MobileBridgeSessionSnapshot>()
  detail: Awaited<ReturnType<IMobileBridgeService['getToolCallDetail']>> = undefined

  private readonly _onDidChange = new Emitter<MobileBridgeEvent>()
  readonly onDidChange = this._onDidChange.event

  emit(event: MobileBridgeEvent): void {
    this._onDidChange.fire(event)
  }
}

interface FakeConnection extends MobileGatewayHubConnection {
  frames: ServerFrame[]
  buffered: number
}

function makeConnection(): FakeConnection {
  const connection: FakeConnection = {
    frames: [],
    buffered: 0,
    send(frame) {
      connection.frames.push(frame)
    },
    bufferedAmount: () => connection.buffered,
  }
  return connection
}

function summary(
  localId: string,
  overrides: Partial<MobileBridgeSessionSummary> = {},
): MobileBridgeSessionSummary {
  return {
    localId,
    agentId: 'fake',
    agentName: 'Fake Agent',
    title: `Session ${localId}`,
    status: 'idle',
    displayStatus: 'idle',
    bucket: 'completed',
    cwd: '/workspace/demo',
    readOnly: false,
    hasPendingPermission: false,
    hasPendingElicitation: false,
    backgroundTaskCount: 0,
    updatedAt: 1,
    ...overrides,
  }
}

function snapshot(
  localId: string,
  overrides: Partial<MobileBridgeSessionSnapshot> = {},
): MobileBridgeSessionSnapshot {
  return {
    summary: summary(localId),
    timeline: [{ kind: 'message', id: 'm1', role: 'user', text: 'hello', streaming: false }],
    plan: [],
    configOptions: [],
    isReplayingHistory: false,
    ...overrides,
  }
}

function event(
  overrides: Partial<Extract<MobileBridgeEvent, { kind: 'session_delta' }>> = {},
): Extract<MobileBridgeEvent, { kind: 'session_delta' }> {
  return {
    kind: 'session_delta',
    localId: 's1',
    events: [
      { type: 'message_upsert', id: 'm1', role: 'agent', streaming: false, textAppend: ' world' },
    ],
    ...overrides,
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function framesOf<T extends ServerFrame['type']>(
  connection: FakeConnection,
  type: T,
): Array<Extract<ServerFrame, { type: T }>> {
  return connection.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: T }> => frame.type === type,
  )
}

describe('MobileGatewayHub', () => {
  it('aggregates inbox snapshots from every window and stamps window facts', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    first.sessions = [summary('s1', { durableId: 'd1' })]
    second.sessions = [summary('s2')]
    hub.registerWindow(1, first, () => 'workspace-a')
    hub.registerWindow(2, second, () => 'workspace-b')

    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    expect(first.startStreaming).toHaveBeenCalledTimes(1)
    expect(second.startStreaming).toHaveBeenCalledTimes(1)

    const snapshots = framesOf(connection, 'inbox_snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.seq).toBe(1)
    expect(snapshots[0]?.sessions).toStrictEqual([
      expect.objectContaining({
        ref: { windowId: 1, localId: 's1', durableId: 'd1' },
        workspaceName: 'workspace-a',
      }),
      expect.objectContaining({
        ref: { windowId: 2, localId: 's2' },
        workspaceName: 'workspace-b',
      }),
    ])
  })

  it('broadcasts inbox deltas and removes sessions when a window closes', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    first.sessions = [summary('s1', { durableId: 'd1' })]
    second.sessions = [summary('s2')]
    hub.registerWindow(1, first)
    hub.registerWindow(2, second)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    connection.frames.length = 0

    first.emit({
      kind: 'inbox',
      upserts: [summary('s1', { title: 'Renamed', durableId: 'd1' })],
      removes: [],
    })
    const deltas = framesOf(connection, 'inbox_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.upserts[0]).toMatchObject({
      ref: { windowId: 1, localId: 's1', durableId: 'd1' },
      title: 'Renamed',
    })

    hub.unregisterWindow(2)
    const removes = framesOf(connection, 'inbox_delta').at(-1)
    expect(removes?.removes).toStrictEqual([{ windowId: 2, localId: 's2' }])
    expect(second.stopStreaming).toHaveBeenCalled()

    first.emit({ kind: 'inbox', upserts: [], removes: [{ localId: 's1', durableId: 'd1' }] })
    expect(framesOf(connection, 'inbox_delta').at(-1)?.removes).toStrictEqual([
      { windowId: 1, localId: 's1', durableId: 'd1' },
    ])
  })

  it('sends a session snapshot then forwards monotonic deltas', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge, () => 'workspace-a')
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    connection.frames.length = 0

    await hub.subscribeSession(connection, { windowId: 1, localId: 's1', durableId: 'd1' })
    const snapshots = framesOf(connection, 'session_snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.seq).toBe(1)
    expect(snapshots[0]?.session.summary.ref).toStrictEqual({
      windowId: 1,
      localId: 's1',
      durableId: 'd1',
    })
    expect(bridge.getSnapshot).toHaveBeenCalledWith('s1')

    bridge.emit(event())
    bridge.emit(event())
    const deltas = framesOf(connection, 'session_delta')
    expect(deltas.map((delta) => delta.seq)).toStrictEqual([2, 3])
    expect(deltas[0]?.ref).toStrictEqual({ windowId: 1, localId: 's1', durableId: 'd1' })
  })

  it('buffers session deltas while the snapshot is in flight', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1')]
    bridge.snapshots.set('s1', snapshot('s1'))
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bridge.getSnapshot.mockImplementationOnce(async () => {
      await gate
      return snapshot('s1')
    })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    const subscribing = hub.subscribeSession(connection, { windowId: 1, localId: 's1' })
    bridge.emit(event({ events: [{ type: 'permission_cleared' }] }))
    release?.()
    await subscribing

    expect(framesOf(connection, 'session_snapshot')).toHaveLength(1)
    const deltas = framesOf(connection, 'session_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.seq).toBe(2)
    expect(deltas[0]?.events).toStrictEqual([{ type: 'permission_cleared' }])
  })

  it('sends session_removed when the referenced session is gone', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.subscribeSession(connection, { windowId: 1, localId: 'missing' })
    expect(connection.frames).toStrictEqual([
      { type: 'session_removed', ref: { windowId: 1, localId: 'missing' } },
    ])

    await hub.subscribeSession(connection, { windowId: 9, localId: 'x', durableId: 'nope' })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'session_removed',
      ref: { windowId: 9, localId: 'x', durableId: 'nope' },
    })
  })

  it('asks for a resync and drops deltas while the socket is backpressured', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    await hub.subscribeSession(connection, { windowId: 1, localId: 's1' })
    connection.frames.length = 0

    connection.buffered = MAX_BUFFERED_SESSION_BYTES + 1
    bridge.emit(event())
    const resync = framesOf(connection, 'resync_required')
    expect(resync).toHaveLength(1)
    expect(resync[0]?.scope).toBe('session')

    connection.buffered = 0
    bridge.emit(event())
    expect(framesOf(connection, 'session_delta')).toHaveLength(0)
  })

  it('routes getToolCallDetail and rejects unknown command kinds', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.detail = {
      id: 'tool-1',
      title: 'Edit',
      kind: 'edit',
      status: 'completed',
      text: 'done',
      diffs: [],
    }
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'r1',
      kind: 'getToolCallDetail',
      payload: { ref, toolCallId: 'tool-1' },
    })
    expect(bridge.getToolCallDetail).toHaveBeenCalledWith('s1', 'tool-1')
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'r1',
      ok: true,
      result: bridge.detail,
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'r2',
      kind: 'futureCommand',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'r2',
      ok: false,
      error: 'not_supported',
    })

    bridge.getToolCallDetail.mockResolvedValueOnce(undefined)
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'r3',
      kind: 'getToolCallDetail',
      payload: { ref: { windowId: 1, localId: 'missing' }, toolCallId: 'tool-1' },
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'r3',
      ok: false,
      error: 'session_not_found',
    })
  })

  it('stops every bridge when the last subscriber leaves and starts new windows', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    hub.registerWindow(1, first)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    expect(first.startStreaming).toHaveBeenCalledTimes(1)

    hub.registerWindow(2, second)
    await tick()
    expect(second.startStreaming).toHaveBeenCalledTimes(1)

    hub.unsubscribeInbox(connection)
    await tick()
    expect(first.stopStreaming).toHaveBeenCalledTimes(1)
    expect(second.stopStreaming).toHaveBeenCalledTimes(1)

    hub.removeConnection(connection)
    await tick()
    expect(first.stopStreaming).toHaveBeenCalledTimes(1)
  })

  it('drops the earliest timeline entries when a snapshot exceeds the soft limit', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1')]
    const big = 'x'.repeat(1100 * 1024)
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        timeline: [
          { kind: 'message', id: 'old', role: 'user', text: big, streaming: false },
          { kind: 'message', id: 'new', role: 'agent', text: 'tail', streaming: false },
        ],
      }),
    )
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.subscribeSession(connection, { windowId: 1, localId: 's1' })
    const snapshotFrame = framesOf(connection, 'session_snapshot')[0]
    expect(snapshotFrame?.session.truncated).toBe(true)
    expect(
      (snapshotFrame?.session.timeline as Array<{ id: string }> | undefined)?.map(
        (item) => item.id,
      ),
    ).toStrictEqual(['new'])
  })
})

describe('MobileGatewayHub protocol events', () => {
  it('converts summary_changed to the protocol summary', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(7, bridge, () => 'workspace-a')
    const connection = makeConnection()
    hub.addConnection(connection)
    await hub.subscribeSession(connection, { windowId: 7, localId: 's1' })
    connection.frames.length = 0

    const summaryEvent: MobileBridgeSessionEvent = {
      type: 'summary_changed',
      summary: {
        ...(bridge.sessions[0] as MobileBridgeSessionSummary),
        title: 'Renamed',
      },
    }
    bridge.emit({
      kind: 'session_delta',
      localId: 's1',
      events: [summaryEvent],
    })
    const delta = framesOf(connection, 'session_delta')[0]
    expect(delta?.events[0]).toMatchObject({
      type: 'summary_changed',
      summary: {
        ref: { windowId: 7, localId: 's1', durableId: 'd1' },
        workspaceName: 'workspace-a',
        title: 'Renamed',
      },
    })
  })
})
