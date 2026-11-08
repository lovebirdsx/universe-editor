import { Emitter, type ILogger } from '@universe-editor/platform'
import type {
  MobileAgentCandidate,
  MobileSessionRef,
  ServerFrame,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import type {
  IMobileBridgeService,
  MobileBridgeEvent,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
} from '../../../../shared/ipc/mobileGatewayService.js'
import {
  COMMAND_IDEMPOTENCY_TTL_MS,
  MAX_BUFFERED_SESSION_BYTES,
  MobileGatewayHub,
  type MobileCommandAudit,
  type MobileGatewayHost,
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
  readonly sendPrompt = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly cancelTurn = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resolvePermission = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly cancelPermission = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resolveElicitation = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly setConfigOption = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly pauseAutoResolve = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resumeAutoResolve = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly newSession = vi.fn(async () => ({
    ok: true as const,
    value: { localId: 'new-local' },
  }))
  readonly renameSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly deleteSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly listWorkspaces = vi.fn(async () => [])
  readonly listAgents = vi.fn(async (): Promise<readonly MobileAgentCandidate[]> => [])

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
    bridge.emit(
      event({
        events: [
          { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'mobile' },
        ],
      }),
    )
    release?.()
    await subscribing

    expect(framesOf(connection, 'session_snapshot')).toHaveLength(1)
    const deltas = framesOf(connection, 'session_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.seq).toBe(2)
    expect(deltas[0]?.events).toStrictEqual([
      { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'mobile' },
    ])
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

describe('MobileGatewayHub commands', () => {
  const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }

  function makeHost(overrides: Partial<MobileGatewayHost> = {}): MobileGatewayHost & {
    listOpenWorkspaces: ReturnType<typeof vi.fn>
    listRecentWorkspaces: ReturnType<typeof vi.fn>
    openWorkspace: ReturnType<typeof vi.fn>
    waitForBridge: ReturnType<typeof vi.fn>
  } {
    return {
      listOpenWorkspaces: vi.fn(() => []),
      listRecentWorkspaces: vi.fn(async () => []),
      openWorkspace: vi.fn(async () => {}),
      waitForBridge: vi.fn(async () => undefined),
      ...overrides,
    } as MobileGatewayHost & {
      listOpenWorkspaces: ReturnType<typeof vi.fn>
      listRecentWorkspaces: ReturnType<typeof vi.fn>
      openWorkspace: ReturnType<typeof vi.fn>
      waitForBridge: ReturnType<typeof vi.fn>
    }
  }

  async function subscribeWithPermission(
    hub: MobileGatewayHub,
    bridge: FakeBridge,
    connection: FakeConnection,
    options: Array<{ optionId: string; allowedOnMobile: boolean }>,
  ): Promise<void> {
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        summary: summary('s1', { durableId: 'd1' }),
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'Run command',
          options: options.map((option) => ({ ...option, name: option.optionId })),
        },
      }),
    )
    hub.registerWindow(1, bridge)
    hub.addConnection(connection)
    await hub.subscribeSession(connection, ref)
    connection.frames.length = 0
  }

  it('routes every session command to its bridge method', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    const cases: Array<[string, unknown, ReturnType<typeof vi.fn>]> = [
      ['sendPrompt', { ref, text: 'hello' }, bridge.sendPrompt],
      ['cancelTurn', { ref }, bridge.cancelTurn],
      ['cancelPermission', { ref, requestId: 'req-1' }, bridge.cancelPermission],
      [
        'resolveElicitation',
        { ref, requestId: 'e1', action: 'accept', content: { name: 'Ada' } },
        bridge.resolveElicitation,
      ],
      ['setConfigOption', { ref, configId: 'mode', value: 'code' }, bridge.setConfigOption],
      ['pauseAutoResolve', { ref, requestId: 'req-1' }, bridge.pauseAutoResolve],
      ['resumeAutoResolve', { ref, requestId: 'req-1' }, bridge.resumeAutoResolve],
      ['renameSession', { ref, title: 'Renamed' }, bridge.renameSession],
      ['deleteSession', { ref }, bridge.deleteSession],
    ]
    for (const [kind, payload, spy] of cases) {
      await hub.handleCommand(connection, { type: 'command', requestId: kind, kind, payload })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(connection.frames.at(-1)).toStrictEqual({
        type: 'command_result',
        requestId: kind,
        ok: true,
      })
    }
    expect(bridge.sendPrompt).toHaveBeenCalledWith('s1', 'hello')
    expect(bridge.resolveElicitation).toHaveBeenCalledWith('s1', 'e1', 'accept', { name: 'Ada' })
  })

  it('rejects a permission option the gateway cannot prove was offered', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const connection = makeConnection()
    await subscribeWithPermission(hub, bridge, connection, [
      { optionId: 'allow-once', allowedOnMobile: true },
      { optionId: 'allow-always', allowedOnMobile: false },
    ])

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'unknown-request',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'missing', optionId: 'allow-once' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'high-risk',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-always' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })
    expect(bridge.resolvePermission).not.toHaveBeenCalled()

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'allowed',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-once', feedback: 'ok' },
    })
    expect(bridge.resolvePermission).toHaveBeenCalledWith('s1', 'req-1', 'allow-once', 'ok')
    expect(connection.frames.at(-1)).toMatchObject({ ok: true })
  })

  it('re-checks high-risk config values before routing', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'bypass',
      kind: 'setConfigOption',
      payload: { ref, configId: 'approval', value: 'bypassPermissions' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })
    expect(bridge.setConfigOption).not.toHaveBeenCalled()

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'mode',
      kind: 'setConfigOption',
      payload: { ref, configId: 'mode', value: 'code' },
    })
    expect(bridge.setConfigOption).toHaveBeenCalledWith('s1', 'mode', 'code')
  })

  it('creates a session in an open window', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n1',
      kind: 'newSession',
      payload: {
        agentId: 'fake',
        workspace: { folder: 'file:///workspace/demo' },
        initialPrompt: 'go',
      },
    })

    expect(host.listRecentWorkspaces).toHaveBeenCalled()
    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(host.waitForBridge).not.toHaveBeenCalled()
    expect(bridge.newSession).toHaveBeenCalledWith(
      'fake',
      { folder: 'file:///workspace/demo' },
      'go',
    )
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'n1',
      ok: true,
      result: { ref: { windowId: 1, localId: 'new-local' } },
    })
  })

  it('opens a recent-only workspace and waits for its bridge', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
      waitForBridge: vi.fn(async () => 5),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.newSession.mockResolvedValueOnce({ ok: true, value: { localId: 'fresh' } })
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n2',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/recent' } },
    })

    expect(host.openWorkspace).toHaveBeenCalledWith('file:///workspace/recent', undefined)
    expect(host.waitForBridge).toHaveBeenCalledWith('file:///workspace/recent', undefined, 30_000)
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'n2',
      ok: true,
      result: { ref: { windowId: 5, localId: 'fresh' } },
    })
  })

  it('reports workspace_not_open when the recent window never produces a bridge', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n3',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/recent' } },
    })
    expect(host.openWorkspace).toHaveBeenCalled()
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'workspace_not_open' })

    const remoteHost = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        {
          folder: 'remote-ssh://host/workspace',
          name: 'remote',
          authority: 'host',
        },
      ]),
    })
    const remoteHub = new MobileGatewayHub(NULL_LOGGER, remoteHost)
    const remoteConnection = makeConnection()
    remoteHub.addConnection(remoteConnection)
    await remoteHub.handleCommand(remoteConnection, {
      type: 'command',
      requestId: 'n4',
      kind: 'newSession',
      payload: {
        agentId: 'fake',
        workspace: { folder: 'remote-ssh://host/workspace', authority: 'host' },
      },
    })
    expect(remoteHost.openWorkspace).not.toHaveBeenCalled()
    expect(remoteConnection.frames.at(-1)).toMatchObject({
      ok: false,
      error: 'workspace_not_open',
    })
  })

  it('rejects workspaces that are neither open nor recent, or have no host', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER, makeHost())
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n5',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/elsewhere' } },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'workspace_not_open' })

    const noHost = new MobileGatewayHub(NULL_LOGGER)
    noHost.addConnection(connection)
    await noHost.handleCommand(connection, {
      type: 'command',
      requestId: 'n6',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/demo' } },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'workspace_not_open' })
  })

  it('lists open and recent workspaces without duplicating either', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/open', name: 'open' },
      ]),
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/open', name: 'open' },
        { folder: 'file:///workspace/older', name: 'older' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w1',
      kind: 'listWorkspaces',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'w1',
      ok: true,
      result: [
        { folder: 'file:///workspace/open', name: 'open', isOpen: true },
        { folder: 'file:///workspace/older', name: 'older', isOpen: false },
      ],
    })
  })

  it('lists agents through the first registered bridge', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'a0',
      kind: 'listAgents',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'a0',
      ok: true,
      result: [],
    })

    const bridge = new FakeBridge()
    bridge.listAgents.mockResolvedValueOnce([{ id: 'fake', name: 'Fake', isDefault: true }])
    hub.registerWindow(1, bridge)
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'a1',
      kind: 'listAgents',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'a1',
      ok: true,
      result: [{ id: 'fake', name: 'Fake', isDefault: true }],
    })
  })

  it('audits mutating commands without prompt or feedback bodies', async () => {
    const audit: MobileCommandAudit = { record: vi.fn() }
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'p1',
        kind: 'sendPrompt',
        payload: { ref, text: 'secret prompt body' },
      },
      audit,
    )
    expect(audit.record).toHaveBeenCalledWith('sendPrompt', 'success', 'window=1 local=s1')
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain('secret prompt body')

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'p2',
        kind: 'newSession',
        payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/demo' } },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith(
      'newSession',
      'failure',
      'agent=fake error=workspace_not_open',
    )

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'p3',
        kind: 'getToolCallDetail',
        payload: { ref, toolCallId: 'tool-1' },
      },
      audit,
    )
    expect(audit.record).toHaveBeenCalledTimes(2)
  })

  it('deduplicates repeated idempotency keys and shares in-flight commands', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    let release: ((result: { ok: true; value: undefined }) => void) | undefined
    bridge.sendPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    const frame = {
      type: 'command' as const,
      requestId: 'i1',
      kind: 'sendPrompt',
      payload: { ref, text: 'hello' },
      idempotencyKey: 'key-1',
    }
    const first = hub.handleCommand(connection, frame)
    const second = hub.handleCommand(connection, { ...frame, requestId: 'i2' })
    release?.({ ok: true, value: undefined })
    await Promise.all([first, second])
    expect(bridge.sendPrompt).toHaveBeenCalledTimes(1)

    await hub.handleCommand(connection, { ...frame, requestId: 'i3' })
    expect(bridge.sendPrompt).toHaveBeenCalledTimes(1)
    expect(framesOf(connection, 'command_result').map((result) => result.requestId)).toEqual([
      'i1',
      'i2',
      'i3',
    ])

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'i4',
      kind: 'getToolCallDetail',
      payload: { ref, toolCallId: 'tool-1' },
      idempotencyKey: 'key-2',
    })
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'i5',
      kind: 'getToolCallDetail',
      payload: { ref, toolCallId: 'tool-1' },
      idempotencyKey: 'key-2',
    })
    expect(bridge.getToolCallDetail).toHaveBeenCalledTimes(2)
  })

  it('times out a command that never settles', async () => {
    vi.useFakeTimers()
    try {
      const hub = new MobileGatewayHub(NULL_LOGGER)
      const bridge = new FakeBridge()
      bridge.sendPrompt.mockImplementationOnce(() => new Promise(() => {}))
      hub.registerWindow(1, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)

      const pending = hub.handleCommand(connection, {
        type: 'command',
        requestId: 't1',
        kind: 'sendPrompt',
        payload: { ref, text: 'hello' },
      })
      await vi.advanceTimersByTimeAsync(5001)
      await pending
      expect(connection.frames.at(-1)).toStrictEqual({
        type: 'command_result',
        requestId: 't1',
        ok: false,
        error: 'internal',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires cached idempotent results after the TTL', async () => {
    vi.useFakeTimers()
    try {
      const hub = new MobileGatewayHub(NULL_LOGGER)
      const bridge = new FakeBridge()
      hub.registerWindow(1, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)
      const frame = {
        type: 'command' as const,
        requestId: 'e1',
        kind: 'sendPrompt',
        payload: { ref, text: 'hello' },
        idempotencyKey: 'expiring',
      }

      await hub.handleCommand(connection, frame)
      await vi.advanceTimersByTimeAsync(COMMAND_IDEMPOTENCY_TTL_MS + 1)
      await hub.handleCommand(connection, { ...frame, requestId: 'e2' })
      expect(bridge.sendPrompt).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
