import { CancellationToken, Emitter, type ILogger } from '@universe-editor/platform'
import {
  MAX_SERVER_FRAME_BYTES,
  MAX_WORKSPACE_NAME_LENGTH,
  type MobileAgentCandidate,
  type MobileSessionRef,
  type MobileSideTaskSummary,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import type {
  IMobileBridgeService,
  MobileBridgeEvent,
  MobileBridgeImage,
  MobileBridgeNewSessionResult,
  MobileBridgeResult,
  MobileBridgeSessionEvent,
  MobileBridgeSessionHistoryEntry,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
} from '../../../../shared/ipc/mobileGatewayService.js'
import { MobileAttachmentError } from '../mobileAttachmentStore.js'
import {
  COMMAND_IDEMPOTENCY_TTL_MS,
  MAX_BUFFERED_SESSION_BYTES,
  MAX_GIT_STATUS_CANDIDATES,
  OPEN_SESSION_TIMEOUT_MS,
  SEND_PROMPT_TIMEOUT_MS,
  MobileGatewayHub,
  NEW_SESSION_TIMEOUT_MS,
  type MobileCommandAudit,
  type MobileGatewayAttention,
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
  readonly startAttention = vi.fn(async () => {})
  readonly stopAttention = vi.fn(async () => {})
  readonly listSessions = vi.fn(async () => this.sessions)
  readonly listSessionHistory = vi.fn(async () => this.history)
  readonly hasSessionHistory = vi.fn(async (durableId: string) =>
    this.history.some((entry) => entry.durableId === durableId),
  )
  readonly openSession = vi.fn(
    async (_durableId: string): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> => ({
      ok: true,
      value: { localId: 'resumed-local', durableId: 'resumed-durable' },
    }),
  )
  readonly getSnapshot = vi.fn(async (localId: string) => this.snapshots.get(localId))
  readonly getToolCallDetail = vi.fn(async () => this.detail)
  readonly getMessageImage = vi.fn(async (): Promise<MobileBridgeImage | undefined> => undefined)
  readonly getWorkspaceImage = vi.fn(async (): Promise<MobileBridgeImage | undefined> => undefined)
  readonly ping = vi.fn(async () => 'pong' as const)
  readonly getWorkspaceGitDirty = vi.fn(async (): Promise<boolean | undefined> => undefined)
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
  readonly closeSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly deleteSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly forkSession = vi.fn(
    async (): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> => ({
      ok: true,
      value: { localId: 'fork-local', durableId: 'fork-durable' },
    }),
  )
  readonly previewRewind = vi.fn(async () => ({
    ok: true as const,
    value: { canRewind: true, filesChanged: 0 },
  }))
  readonly rewindSession = vi.fn(async () => ({
    ok: true as const,
    value: { canRewind: true },
  }))
  readonly createSideTask = vi.fn(
    async (): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> => ({
      ok: true,
      value: { localId: 'side-local', durableId: 'side-durable' },
    }),
  )
  readonly listSideTasks = vi.fn(
    async (): Promise<{ ok: true; value: readonly MobileSideTaskSummary[] }> => ({
      ok: true,
      value: [],
    }),
  )
  readonly openSideTask = vi.fn(
    async (): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> => ({
      ok: true,
      value: { localId: 'side-local', durableId: 'side-durable' },
    }),
  )
  readonly deleteSideTask = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly listWorkspaces = vi.fn(async () => [])
  readonly listAgents = vi.fn(async (): Promise<readonly MobileAgentCandidate[]> => [])

  sessions: MobileBridgeSessionSummary[] = []
  history: MobileBridgeSessionHistoryEntry[] = []
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

function historyRow(
  durableId: string,
  overrides: Partial<MobileBridgeSessionHistoryEntry> = {},
): MobileBridgeSessionHistoryEntry {
  return {
    durableId,
    agentId: 'fake',
    agentName: 'Fake Agent',
    title: `History ${durableId}`,
    firstPrompt: 'first prompt',
    createdAt: 1,
    lastUsedAt: 1,
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
    availableCommands: [],
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

  it('forwards fork/rewind capabilities and clamped side-task fields', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [
      summary('s1', {
        durableId: 'd1',
        forkSupported: true,
        rewindSupported: true,
        sideTaskOf: 'parent-durable',
        sideTaskChildCount: 2,
      }),
      summary('s2', { sideTaskChildCount: -1 }),
    ]
    hub.registerWindow(1, bridge, () => 'workspace-a')
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    const sessions = framesOf(connection, 'inbox_snapshot')[0]?.sessions ?? []
    expect(sessions[0]).toMatchObject({
      forkSupported: true,
      rewindSupported: true,
      sideTaskOf: 'parent-durable',
      sideTaskChildCount: 2,
    })
    expect(sessions[1]).not.toHaveProperty('sideTaskChildCount')
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

  it('wires inbox streaming after the renderer answers', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.ping
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    hub.subscribeInbox(connection)
    expect(bridge.startStreaming).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(bridge.startStreaming).toHaveBeenCalledTimes(1))
    connection.frames.length = 0

    bridge.emit({ kind: 'inbox', upserts: [summary('s1')], removes: [] })
    expect(framesOf(connection, 'inbox_delta')).toHaveLength(1)
  })

  it('rebuilds the event wiring after the renderer stops answering', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    hub.subscribeInbox(connection)
    await vi.waitFor(() => expect(bridge.startStreaming).toHaveBeenCalledTimes(1))
    connection.frames.length = 0

    bridge.emit({ kind: 'inbox', upserts: [summary('s1')], removes: [] })
    expect(framesOf(connection, 'inbox_delta')).toHaveLength(1)

    // A reload kills the old renderer's wiring: probes fail, then the fresh
    // renderer answers and the hub must re-subscribe and re-enable streaming.
    bridge.ping
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'wake',
      kind: 'listAgents',
      payload: {},
    })
    await vi.waitFor(() => expect(bridge.startStreaming).toHaveBeenCalledTimes(2))
    connection.frames.length = 0

    bridge.emit({ kind: 'inbox', upserts: [summary('s1', { title: 'After reload' })], removes: [] })
    expect(framesOf(connection, 'inbox_delta')).toHaveLength(1)
  })

  it('tells a subscribed phone when the session leaves the inbox', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    await hub.subscribeSession(connection, { windowId: 1, localId: 's1', durableId: 'd1' })
    connection.frames.length = 0

    bridge.emit({
      kind: 'inbox',
      upserts: [],
      removes: [{ localId: 's1', durableId: 'd1' }],
    })

    expect(framesOf(connection, 'session_removed')).toStrictEqual([
      {
        type: 'session_removed',
        ref: { windowId: 1, localId: 's1', durableId: 'd1' },
      },
    ])
    expect(framesOf(connection, 'inbox_delta').at(-1)?.removes).toStrictEqual([
      { windowId: 1, localId: 's1', durableId: 'd1' },
    ])
  })

  it('does not deliver a late snapshot after the session leaves the inbox', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bridge.getSnapshot.mockImplementationOnce(async () => {
      await gate
      return snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) })
    })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    connection.frames.length = 0

    const subscribing = hub.subscribeSession(connection, {
      windowId: 1,
      localId: 's1',
      durableId: 'd1',
    })
    bridge.emit({
      kind: 'inbox',
      upserts: [],
      removes: [{ localId: 's1', durableId: 'd1' }],
    })
    release?.()
    await subscribing

    expect(framesOf(connection, 'session_snapshot')).toHaveLength(0)
    expect(framesOf(connection, 'session_removed')).toHaveLength(1)
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
    expect(bridge.getSnapshot).toHaveBeenCalledWith('s1', expect.anything())

    bridge.emit(event())
    bridge.emit(event())
    const deltas = framesOf(connection, 'session_delta')
    expect(deltas.map((delta) => delta.seq)).toStrictEqual([2, 3])
    expect(deltas[0]?.ref).toStrictEqual({ windowId: 1, localId: 's1', durableId: 'd1' })
  })

  it('waits for the renderer bridge before requesting a session snapshot', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1')]
    bridge.snapshots.set('s1', snapshot('s1'))
    bridge.ping
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.subscribeSession(connection, { windowId: 1, localId: 's1' })

    expect(bridge.getSnapshot).toHaveBeenCalledWith('s1', expect.anything())
    expect(framesOf(connection, 'session_snapshot')).toHaveLength(1)
  })

  it('drops frames that fail protocol validation and logs the failure', async () => {
    const error = vi.fn()
    const logger = { ...NULL_LOGGER, error } as unknown as ILogger
    const hub = new MobileGatewayHub(logger)
    const bridge = new FakeBridge()
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        timeline: [
          {
            kind: 'toolCall',
            id: 'tool-1',
            title: 'x'.repeat(2_000),
            toolKind: 'execute',
            status: 'completed',
            hasDetail: false,
          },
        ],
      }),
    )
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.subscribeSession(connection, { windowId: 1, localId: 's1' })

    expect(framesOf(connection, 'session_snapshot')).toHaveLength(0)
    expect(error).toHaveBeenCalledTimes(1)
    const message = error.mock.calls[0]?.[0] as string
    expect(message).toContain('session_snapshot')
    expect(message).toContain('s1')
    expect(message).not.toContain('x'.repeat(10))
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
    // The bridge subscription is wired only after the readiness ping answers.
    await vi.waitFor(() => expect(bridge.startStreaming).toHaveBeenCalledTimes(1))
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
    readWorkspaceSessionHistory: ReturnType<typeof vi.fn>
    sessionHistoryWorkspaceLimit: ReturnType<typeof vi.fn>
  } {
    return {
      listOpenWorkspaces: vi.fn(() => []),
      listRecentWorkspaces: vi.fn(async () => []),
      openWorkspace: vi.fn(async () => {}),
      waitForBridge: vi.fn(async () => undefined),
      readWorkspaceSessionHistory: vi.fn(async () => []),
      sessionHistoryWorkspaceLimit: vi.fn(() => 20),
      ...overrides,
    } as MobileGatewayHost & {
      listOpenWorkspaces: ReturnType<typeof vi.fn>
      listRecentWorkspaces: ReturnType<typeof vi.fn>
      openWorkspace: ReturnType<typeof vi.fn>
      waitForBridge: ReturnType<typeof vi.fn>
      readWorkspaceSessionHistory: ReturnType<typeof vi.fn>
      sessionHistoryWorkspaceLimit: ReturnType<typeof vi.fn>
    }
  }

  async function subscribeWithPermission(
    hub: MobileGatewayHub,
    bridge: FakeBridge,
    connection: FakeConnection,
    options: Array<{ optionId: string; kind?: string; allowedOnMobile: boolean }>,
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
      ['closeSession', { ref }, bridge.closeSession],
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

  it('aggregates history across windows, dedupes durable ids and stamps window facts', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    first.history = [
      historyRow('d1', { title: 'A', lastUsedAt: 10 }),
      historyRow('d2', { pinned: true, lastUsedAt: 5 }),
    ]
    second.history = [historyRow('d1', { title: 'A newer', lastUsedAt: 20 })]
    hub.registerWindow(1, first, () => 'workspace-a')
    hub.registerWindow(2, second, () => 'workspace-b')
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history',
      kind: 'listSessionHistory',
      payload: {},
    })

    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'history',
      ok: true,
      result: [
        {
          durableId: 'd2',
          windowId: 1,
          agentId: 'fake',
          agentName: 'Fake Agent',
          title: 'History d2',
          firstPrompt: 'first prompt',
          workspaceName: 'workspace-a',
          createdAt: 1,
          lastUsedAt: 5,
          pinned: true,
        },
        {
          durableId: 'd1',
          windowId: 2,
          agentId: 'fake',
          agentName: 'Fake Agent',
          title: 'A newer',
          firstPrompt: 'first prompt',
          workspaceName: 'workspace-b',
          createdAt: 1,
          lastUsedAt: 20,
        },
      ],
    })
  })

  it('returns the live ref for a history id without resuming it again', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('live-1', { durableId: 'd1' })]
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()
    connection.frames.length = 0

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open',
      kind: 'openSession',
      payload: { durableId: 'd1', windowId: 1 },
    })

    expect(bridge.openSession).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'open',
      ok: true,
      result: { ref: { windowId: 1, localId: 'live-1', durableId: 'd1' } },
    })
  })

  it('routes a history-only session to its owning window and rejects unknown ids', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    second.history = [historyRow('d1')]
    hub.registerWindow(1, first)
    hub.registerWindow(2, second)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open',
      kind: 'openSession',
      payload: { durableId: 'd1' },
    })
    expect(first.openSession).not.toHaveBeenCalled()
    expect(second.openSession).toHaveBeenCalledWith('d1', expect.anything())
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'open',
      ok: true,
      result: {
        ref: { windowId: 2, localId: 'resumed-local', durableId: 'resumed-durable' },
      },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'missing',
      kind: 'openSession',
      payload: { durableId: 'missing' },
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'missing',
      ok: false,
      error: 'session_not_found',
    })
  })

  it('drops malformed history rows instead of failing the whole list', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.history = [
      historyRow('d1'),
      historyRow(''),
      historyRow('d2', { agentId: '' }),
      historyRow('d3', { createdAt: Number.NaN }),
      historyRow('d4', { lastUsedAt: Number.POSITIVE_INFINITY }),
    ]
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history',
      kind: 'listSessionHistory',
      payload: {},
    })

    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({
      requestId: 'history',
      ok: true,
      result: [{ durableId: 'd1' }],
    })
  })

  it('falls back to another owner window and audits the actual window', async () => {
    const audit: MobileCommandAudit = { record: vi.fn() }
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const hinted = new FakeBridge()
    const owner = new FakeBridge()
    hinted.history = [historyRow('d1')]
    owner.history = [historyRow('d1')]
    hinted.openSession.mockResolvedValueOnce({
      ok: false,
      code: 'session_not_found',
      message: 'session not found',
    })
    hub.registerWindow(1, hinted)
    hub.registerWindow(2, owner)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'open',
        kind: 'openSession',
        payload: { durableId: 'd1', windowId: 1 },
      },
      audit,
    )

    expect(hinted.openSession).toHaveBeenCalledTimes(1)
    expect(owner.openSession).toHaveBeenCalledTimes(1)
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({
      ok: true,
      result: { ref: { windowId: 2, localId: 'resumed-local' } },
    })
    expect(audit.record).toHaveBeenCalledWith(
      'openSession',
      'success',
      'window=2 local=resumed-local',
    )
  })

  it('dedupes concurrent resumes of the same durable id', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.history = [historyRow('d1')]
    let release!: (value: MobileBridgeResult<MobileBridgeNewSessionResult>) => void
    bridge.openSession.mockImplementationOnce(
      () =>
        new Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>((resolve) => {
          release = resolve
        }),
    )
    hub.registerWindow(1, bridge)
    const first = makeConnection()
    const second = makeConnection()
    hub.addConnection(first)
    hub.addConnection(second)

    const firstRun = hub.handleCommand(first, {
      type: 'command',
      requestId: 'a',
      kind: 'openSession',
      payload: { durableId: 'd1' },
    })
    const secondRun = hub.handleCommand(second, {
      type: 'command',
      requestId: 'b',
      kind: 'openSession',
      payload: { durableId: 'd1' },
    })
    await tick()
    expect(bridge.openSession).toHaveBeenCalledTimes(1)

    release({ ok: true, value: { localId: 'local-x', durableId: 'd1' } })
    await Promise.all([firstRun, secondRun])
    expect(framesOf(first, 'command_result').at(-1)).toMatchObject({ requestId: 'a', ok: true })
    expect(framesOf(second, 'command_result').at(-1)).toMatchObject({ requestId: 'b', ok: true })

    await hub.handleCommand(first, {
      type: 'command',
      requestId: 'c',
      kind: 'openSession',
      payload: { durableId: 'd1' },
    })
    expect(bridge.openSession).toHaveBeenCalledTimes(2)
  })

  it('merges closed-workspace disk history, prefers open rows and caps workspaces', async () => {
    const recent = [
      { folder: 'file:///workspace/recent-1', name: 'recent-1' },
      { folder: 'remote-ssh://devhost/home/dev/project', name: 'remote', authority: 'devhost' },
      { folder: 'file:///workspace/recent-3', name: 'recent-3' },
      { folder: 'file:///workspace/open', name: 'open' },
    ]
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/open', name: 'open' },
      ]),
      listRecentWorkspaces: vi.fn(async () => recent),
      readWorkspaceSessionHistory: vi.fn(async (workspace: { name: string }) => {
        if (workspace.name === 'recent-1') return [historyRow('d1', { title: 'stale copy' })]
        if (workspace.name === 'remote') {
          return [historyRow('d2', { title: 'remote row', authority: 'devhost' })]
        }
        return [historyRow('d3', { title: 'capped row' })]
      }),
      sessionHistoryWorkspaceLimit: vi.fn(() => 2),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const open = new FakeBridge()
    open.history = [historyRow('d1', { title: 'open wins', lastUsedAt: 30 })]
    hub.registerWindow(1, open, () => 'open')
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history',
      kind: 'listSessionHistory',
      payload: {},
    })

    expect(host.readWorkspaceSessionHistory).toHaveBeenCalledTimes(2)
    expect(host.readWorkspaceSessionHistory).toHaveBeenCalledWith(recent[0])
    expect(host.readWorkspaceSessionHistory).toHaveBeenCalledWith(recent[1])
    const result = framesOf(connection, 'command_result').at(-1)?.result as Array<
      Record<string, unknown>
    >
    expect(result.map((row) => row['durableId'])).toEqual(['d1', 'd2'])
    expect(result[0]).toMatchObject({
      durableId: 'd1',
      windowId: 1,
      workspaceName: 'open',
      title: 'open wins',
    })
    expect(result[0]).not.toHaveProperty('folder')
    expect(result[1]).toMatchObject({
      durableId: 'd2',
      workspaceName: 'remote',
      folder: recent[1]?.folder,
      authority: 'devhost',
    })
    expect(result[1]).not.toHaveProperty('windowId')
  })

  it('opens a closed workspace before resuming its history session', async () => {
    const folder = 'file:///workspace/recent'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'recent' }]),
      waitForBridge: vi.fn(async () => 5),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    // Owner scan misses; the freshly opened window's poll then finds it.
    bridge.hasSessionHistory.mockResolvedValueOnce(false).mockResolvedValue(true)
    bridge.openSession.mockResolvedValueOnce({
      ok: true,
      value: { localId: 'resumed-local', durableId: 'd1' },
    })
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-closed',
      kind: 'openSession',
      payload: { durableId: 'd1', folder },
    })

    expect(host.openWorkspace).toHaveBeenCalledWith(folder, undefined)
    expect(host.waitForBridge).toHaveBeenCalledWith(folder, undefined, expect.any(Number))
    expect(bridge.ping).toHaveBeenCalled()
    expect(bridge.openSession).toHaveBeenCalledWith('d1', expect.anything())
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({
      ok: true,
      result: { ref: { windowId: 5, localId: 'resumed-local', durableId: 'd1' } },
    })
  })

  it('opens a closed remote workspace before resuming its history session', async () => {
    const folder = 'remote-ssh://devhost/home/dev/project'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'project', authority: 'devhost' }]),
      waitForBridge: vi.fn(async () => 7),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.hasSessionHistory.mockResolvedValueOnce(false).mockResolvedValue(true)
    hub.registerWindow(7, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-remote',
      kind: 'openSession',
      payload: { durableId: 'd1', folder, authority: 'devhost' },
    })

    expect(host.openWorkspace).toHaveBeenCalledWith(folder, 'devhost')
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({ ok: true })
  })

  it('reports workspace_not_open when the closed workspace cannot be opened', async () => {
    const folder = 'file:///workspace/recent'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'recent' }]),
      waitForBridge: vi.fn(async () => undefined),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-failed',
      kind: 'openSession',
      payload: { durableId: 'd1', folder },
    })

    expect(framesOf(connection, 'command_result').at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'open-failed',
      ok: false,
      error: 'workspace_not_open',
    })
  })

  it('reports workspace_not_open when opening the workspace rejects', async () => {
    const folder = 'file:///workspace/recent'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'recent' }]),
      openWorkspace: vi.fn(async () => {
        throw new Error('open failed')
      }),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-rejected',
      kind: 'openSession',
      payload: { durableId: 'd1', folder },
    })

    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({
      ok: false,
      error: 'workspace_not_open',
    })
  })

  it('waits for a freshly opened window to publish the history row', async () => {
    const folder = 'file:///workspace/recent'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'recent' }]),
      waitForBridge: vi.fn(async () => 5),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    // First call is the owner scan; the next two are the post-open polls.
    bridge.hasSessionHistory
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-polled',
      kind: 'openSession',
      payload: { durableId: 'd1', folder },
    })

    expect(bridge.hasSessionHistory).toHaveBeenCalledTimes(3)
    expect(bridge.openSession).toHaveBeenCalledWith('d1', expect.anything())
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({ ok: true })
  })

  it('gives up within the shared deadline when the opened window never publishes it', async () => {
    vi.useFakeTimers()
    try {
      const folder = 'file:///workspace/recent'
      const host = makeHost({
        listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'recent' }]),
        waitForBridge: vi.fn(async () => 5),
      })
      const hub = new MobileGatewayHub(NULL_LOGGER, host)
      const bridge = new FakeBridge()
      bridge.hasSessionHistory.mockResolvedValue(false)
      hub.registerWindow(5, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)

      const command = hub.handleCommand(connection, {
        type: 'command',
        requestId: 'open-timeout',
        kind: 'openSession',
        payload: { durableId: 'd1', folder },
      })
      await vi.advanceTimersByTimeAsync(OPEN_SESSION_TIMEOUT_MS + 1_000)
      await command

      expect(bridge.openSession).not.toHaveBeenCalled()
      expect(framesOf(connection, 'command_result').at(-1)).toStrictEqual({
        type: 'command_result',
        requestId: 'open-timeout',
        ok: false,
        error: 'session_not_found',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reverse-looks a deep-linked durable id in closed workspace buckets', async () => {
    const folder = 'remote-ssh://devhost/home/dev/project'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'project', authority: 'devhost' }]),
      readWorkspaceSessionHistory: vi.fn(async () => [historyRow('deep-id')]),
      waitForBridge: vi.fn(async () => 7),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.hasSessionHistory.mockResolvedValueOnce(false).mockResolvedValue(true)
    hub.registerWindow(7, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-deep',
      kind: 'openSession',
      payload: { durableId: 'deep-id' },
    })

    expect(host.readWorkspaceSessionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ folder, name: 'project' }),
    )
    expect(host.openWorkspace).toHaveBeenCalledWith(folder, 'devhost')
    expect(bridge.openSession).toHaveBeenCalledWith('deep-id', expect.anything())
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({ ok: true })
  })

  it('rejects a folder that is neither open nor recent without opening it', async () => {
    const host = makeHost()
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open-unknown',
      kind: 'openSession',
      payload: { durableId: 'd1', folder: 'file:///workspace/not-listed' },
    })

    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(framesOf(connection, 'command_result').at(-1)).toMatchObject({
      ok: false,
      error: 'workspace_not_open',
    })
  })

  it('falls back to the workspace bucket when an open window cannot list history', async () => {
    const workspace = {
      windowId: 1,
      folder: 'file:///workspace/open',
      name: 'open',
    }
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [workspace]),
      readWorkspaceSessionHistory: vi.fn(async () => [historyRow('d1', { title: 'from disk' })]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.listSessionHistory.mockRejectedValueOnce(new Error('renderer timed out'))
    hub.registerWindow(1, bridge, () => 'open')
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history-fallback',
      kind: 'listSessionHistory',
      payload: {},
    })

    expect(host.readWorkspaceSessionHistory).toHaveBeenCalledWith(workspace)
    const result = framesOf(connection, 'command_result').at(-1)?.result as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      durableId: 'd1',
      title: 'from disk',
      workspaceName: 'open',
      folder: workspace.folder,
    })
    expect(result[0]).not.toHaveProperty('windowId')
  })

  it('dedupes disk rows with the same pinned/freshness rule as open rows', async () => {
    const recent = [
      { folder: 'file:///workspace/a', name: 'a' },
      { folder: 'file:///workspace/b', name: 'b' },
    ]
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => recent),
      readWorkspaceSessionHistory: vi.fn(async (workspace: { name: string }) =>
        workspace.name === 'a'
          ? [historyRow('d1', { lastUsedAt: 10 }), historyRow('d2', { lastUsedAt: 10 })]
          : [
              historyRow('d1', { pinned: true, lastUsedAt: 5 }),
              historyRow('d2', { lastUsedAt: 20 }),
            ],
      ),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history-dedupe',
      kind: 'listSessionHistory',
      payload: {},
    })

    const result = framesOf(connection, 'command_result').at(-1)?.result as Array<
      Record<string, unknown>
    >
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ durableId: 'd1', pinned: true })
    expect(result[1]).toMatchObject({ durableId: 'd2', lastUsedAt: 20 })
  })

  it('falls back to the default or hard cap for an unusable workspace limit', async () => {
    const recent = Array.from({ length: 105 }, (_value, index) => ({
      folder: `file:///workspace/w${index}`,
      name: `w${index}`,
    }))
    const run = async (limit: number): Promise<number> => {
      const host = makeHost({
        listRecentWorkspaces: vi.fn(async () => recent),
        sessionHistoryWorkspaceLimit: vi.fn(() => limit),
      })
      const hub = new MobileGatewayHub(NULL_LOGGER, host)
      const connection = makeConnection()
      hub.addConnection(connection)
      await hub.handleCommand(connection, {
        type: 'command',
        requestId: `history-limit-${limit}`,
        kind: 'listSessionHistory',
        payload: {},
      })
      return host.readWorkspaceSessionHistory.mock.calls.length
    }

    expect(await run(0)).toBe(20)
    expect(await run(Number.NaN)).toBe(20)
    expect(await run(2.5)).toBe(20)
    expect(await run(101)).toBe(100)
  })

  it('drops over-long workspace hints instead of truncating identities', async () => {
    const folder = `file:///${'a'.repeat(MAX_SERVER_FRAME_BYTES)}`
    const authority = 'h'.repeat(MAX_WORKSPACE_NAME_LENGTH + 1)
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'huge', authority }]),
      readWorkspaceSessionHistory: vi.fn(async () => [historyRow('d1', { authority })]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'history-hints',
      kind: 'listSessionHistory',
      payload: {},
    })

    const result = framesOf(connection, 'command_result').at(-1)?.result as Array<
      Record<string, unknown>
    >
    expect(result[0]).toMatchObject({ durableId: 'd1', workspaceName: 'huge' })
    expect(result[0]).not.toHaveProperty('folder')
    expect(result[0]).not.toHaveProperty('authority')
  })

  it('routes fork, rewind and side-task commands and stamps created refs', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const localRef: MobileSessionRef = { windowId: 7, localId: 's1' }
    hub.registerWindow(7, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'fork',
      kind: 'forkSession',
      payload: { ref: localRef, messageId: 'msg-1' },
    })
    expect(bridge.forkSession).toHaveBeenCalledWith('s1', 'msg-1')
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'fork',
      ok: true,
      result: { ref: { windowId: 7, localId: 'fork-local', durableId: 'fork-durable' } },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'preview',
      kind: 'previewRewind',
      payload: { ref: localRef, messageId: 'msg-1' },
    })
    expect(bridge.previewRewind).toHaveBeenCalledWith('s1', 'msg-1')
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'preview',
      ok: true,
      result: { canRewind: true, filesChanged: 0 },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'rewind',
      kind: 'rewindSession',
      payload: { ref: localRef, messageId: 'msg-1', rewindFiles: false },
    })
    expect(bridge.rewindSession).toHaveBeenCalledWith('s1', 'msg-1', false)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'side',
      kind: 'createSideTask',
      payload: { ref: localRef, quote: 'why?' },
    })
    expect(bridge.createSideTask).toHaveBeenCalledWith('s1', 'why?')
    expect(connection.frames.at(-1)).toMatchObject({
      ok: true,
      result: { ref: { windowId: 7, localId: 'side-local', durableId: 'side-durable' } },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'list',
      kind: 'listSideTasks',
      payload: { ref: localRef },
    })
    expect(bridge.listSideTasks).toHaveBeenCalledWith('s1')
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'list',
      ok: true,
      result: [],
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'open',
      kind: 'openSideTask',
      payload: { ref: localRef, sideTaskId: 'side-durable' },
    })
    expect(bridge.openSideTask).toHaveBeenCalledWith('s1', 'side-durable')
    expect(connection.frames.at(-1)).toMatchObject({
      ok: true,
      result: { ref: { windowId: 7, localId: 'side-local', durableId: 'side-durable' } },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete',
      kind: 'deleteSideTask',
      payload: { ref: localRef, sideTaskId: 'side-durable' },
    })
    expect(bridge.deleteSideTask).toHaveBeenCalledWith('s1', 'side-durable')
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'delete',
      ok: true,
    })
  })

  it('rejects a malformed created session ref from the renderer', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.createSideTask.mockResolvedValueOnce({ ok: true, value: { localId: '' } })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'bad',
      kind: 'createSideTask',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'bad',
      ok: false,
      error: 'internal',
    })
  })

  it('clamps malformed side-task rows from the renderer', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.listSideTasks.mockResolvedValueOnce({
      ok: true,
      value: [
        { id: 'side-1', title: 'x'.repeat(600), lastUsedAt: Number.NaN, live: 'yes' },
        { id: '', title: 'dropped', lastUsedAt: 1, live: true },
        'junk',
      ],
    } as unknown as { ok: true; value: readonly MobileSideTaskSummary[] })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'list',
      kind: 'listSideTasks',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })
    const result = framesOf(connection, 'command_result').at(-1)?.result as MobileSideTaskSummary[]
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'side-1', lastUsedAt: 0, live: false })
    expect(result[0]?.title).toHaveLength(512)
  })

  it('answers a request the gateway never cached as stale_request', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const connection = makeConnection()
    await subscribeWithPermission(hub, bridge, connection, [
      { optionId: 'allow-once', allowedOnMobile: true },
    ])

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'unknown-request',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'missing', optionId: 'allow-once' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'stale_request' })
    expect(bridge.resolvePermission).not.toHaveBeenCalled()
  })

  it('answers a repeated resolve after permission_cleared as stale_request', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const connection = makeConnection()
    await subscribeWithPermission(hub, bridge, connection, [
      { optionId: 'allow-once', allowedOnMobile: true },
    ])
    // The bridge's throttled flush delivers permission_cleared later than the first
    // resolve settles; once it reaches the gateway the cache entry is gone. A
    // duplicate tap must still read as "already handled", never as a policy denial.
    bridge.emit(
      event({
        events: [
          { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'mobile' },
        ],
      }),
    )

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'repeat',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-once' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'stale_request' })
    expect(bridge.resolvePermission).not.toHaveBeenCalled()
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
    expect(bridge.resolvePermission).toHaveBeenCalledWith('s1', 'req-1', 'allow-once', false, 'ok')
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
    expect(bridge.setConfigOption).toHaveBeenCalledWith('s1', 'mode', 'code', false)
  })

  it('widens high-risk options only for a trusted connection and keeps the cache conservative', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        summary: summary('s1', { durableId: 'd1' }),
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'select',
            currentValue: 'ask',
            allowedOnMobile: true,
            options: [
              { value: 'ask', label: 'Ask', allowedOnMobile: true },
              { value: 'bypassPermissions', label: 'Bypass', allowedOnMobile: false },
            ],
          },
        ],
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'Run command',
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
              allowedOnMobile: true,
            },
            {
              optionId: 'allow-always',
              name: 'Always',
              kind: 'allow_always',
              allowedOnMobile: false,
            },
          ],
        },
      }),
    )
    hub.registerWindow(1, bridge)
    const trusted = makeConnection()
    const plain = makeConnection()
    hub.addConnection(trusted)
    hub.addConnection(plain)
    hub.authenticateConnection(trusted, { deviceId: 'd-trusted', trusted: true })
    hub.authenticateConnection(plain, { deviceId: 'd-plain', trusted: false })
    await hub.subscribeSession(trusted, ref)
    await hub.subscribeSession(plain, ref)

    const trustedSnapshot = framesOf(trusted, 'session_snapshot')[0]?.session
    const plainSnapshot = framesOf(plain, 'session_snapshot')[0]?.session
    expect(trustedSnapshot?.configOptions[0]?.options?.[1]?.allowedOnMobile).toBe(true)
    expect(plainSnapshot?.configOptions[0]?.options?.[1]?.allowedOnMobile).toBe(false)
    expect(trustedSnapshot?.pendingPermission?.options[1]?.allowedOnMobile).toBe(true)
    expect(plainSnapshot?.pendingPermission?.options[1]?.allowedOnMobile).toBe(false)

    const command = {
      type: 'command' as const,
      requestId: 'durable',
      kind: 'resolvePermission' as const,
      payload: { ref, requestId: 'req-1', optionId: 'allow-always' },
    }
    await hub.handleCommand(plain, command)
    expect(plain.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })
    expect(bridge.resolvePermission).not.toHaveBeenCalled()

    await hub.handleCommand(trusted, command)
    expect(bridge.resolvePermission).toHaveBeenCalledWith(
      's1',
      'req-1',
      'allow-always',
      true,
      undefined,
    )
    expect(trusted.frames.at(-1)).toMatchObject({ ok: true })

    // The shared cache still reflects the conservative projection.
    await hub.handleCommand(plain, { ...command, requestId: 'durable-2' })
    expect(plain.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })
  })

  it('resyncs only the affected connection when trust changes', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        summary: summary('s1', { durableId: 'd1' }),
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'Run command',
          options: [
            {
              optionId: 'allow-always',
              name: 'Always',
              kind: 'allow_always',
              allowedOnMobile: false,
            },
          ],
        },
      }),
    )
    hub.registerWindow(1, bridge)
    const target = makeConnection()
    const other = makeConnection()
    hub.addConnection(target)
    hub.addConnection(other)
    hub.authenticateConnection(target, { deviceId: 'd1', trusted: false })
    hub.authenticateConnection(other, { deviceId: 'd2', trusted: false })
    await hub.subscribeSession(target, ref)
    await hub.subscribeSession(other, ref)
    target.frames.length = 0
    other.frames.length = 0

    hub.setConnectionTrust(target, 'd1', true)
    expect(framesOf(target, 'resync_required')).toHaveLength(1)
    expect(framesOf(target, 'resync_required')[0]).toMatchObject({ reason: 'trust_changed' })
    expect(framesOf(other, 'resync_required')).toHaveLength(0)
    expect(hub.isConnectionTrusted(target)).toBe(true)
    expect(hub.isConnectionTrusted(other)).toBe(false)

    await hub.subscribeSession(target, ref)
    const updatedSnapshot = framesOf(target, 'session_snapshot').at(-1)?.session
    expect(updatedSnapshot?.pendingPermission?.options[0]?.allowedOnMobile).toBe(true)

    target.frames.length = 0
    hub.setConnectionTrust(target, 'd1', false)
    expect(framesOf(target, 'resync_required')).toHaveLength(1)

    await hub.subscribeSession(target, ref)
    const narrowedSnapshot = framesOf(target, 'session_snapshot').at(-1)?.session
    expect(narrowedSnapshot?.pendingPermission?.options[0]?.allowedOnMobile).toBe(false)

    await hub.handleCommand(target, {
      type: 'command',
      requestId: 'after-revoke',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-always' },
    })
    expect(target.frames.at(-1)).toMatchObject({ ok: false, error: 'forbidden_operation' })
    expect(bridge.resolvePermission).not.toHaveBeenCalled()
  })

  it('widens session deltas only for a trusted connection', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const trusted = makeConnection()
    const plain = makeConnection()
    hub.addConnection(trusted)
    hub.addConnection(plain)
    hub.authenticateConnection(trusted, { deviceId: 'd-trusted', trusted: true })
    hub.authenticateConnection(plain, { deviceId: 'd-plain', trusted: false })
    await hub.subscribeSession(trusted, ref)
    await hub.subscribeSession(plain, ref)

    bridge.emit(
      event({
        events: [
          {
            type: 'config_options_snapshot',
            options: [
              {
                id: 'approval',
                name: 'Approval',
                type: 'select',
                currentValue: 'ask',
                allowedOnMobile: true,
                options: [
                  { value: 'ask', label: 'Ask', allowedOnMobile: true },
                  { value: 'bypassPermissions', label: 'Bypass', allowedOnMobile: false },
                ],
              },
            ],
          },
          {
            type: 'permission_upsert',
            permission: {
              requestId: 'req-1',
              toolCallId: 'tool-1',
              title: 'Run command',
              options: [
                {
                  optionId: 'allow-always',
                  name: 'Always',
                  kind: 'allow_always',
                  allowedOnMobile: false,
                },
              ],
            },
          },
        ],
      }),
    )

    const trustedEvents = framesOf(trusted, 'session_delta').at(-1)?.events
    const plainEvents = framesOf(plain, 'session_delta').at(-1)?.events
    expect(trustedEvents?.[0]).toMatchObject({
      type: 'config_options_snapshot',
      options: [{ options: [{ allowedOnMobile: true }, { allowedOnMobile: true }] }],
    })
    expect(trustedEvents?.[1]).toMatchObject({
      type: 'permission_upsert',
      permission: { options: [{ allowedOnMobile: true }] },
    })
    expect(plainEvents?.[0]).toMatchObject({
      type: 'config_options_snapshot',
      options: [{ options: [{ allowedOnMobile: true }, { allowedOnMobile: false }] }],
    })
    expect(plainEvents?.[1]).toMatchObject({
      type: 'permission_upsert',
      permission: { options: [{ allowedOnMobile: false }] },
    })
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
      expect.anything(),
    )
    expect(CancellationToken.isCancellationToken((bridge.ping.mock.calls[0] as unknown[])[0])).toBe(
      true,
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
    expect(host.waitForBridge).toHaveBeenCalledWith(
      'file:///workspace/recent',
      undefined,
      expect.any(Number),
    )
    expect(bridge.ping).toHaveBeenCalled()
    // Without a prompt the third argument stays `null` so the proxy does not
    // strip it and shift the cancellation token into the prompt slot.
    expect(bridge.newSession).toHaveBeenCalledWith(
      'fake',
      { folder: 'file:///workspace/recent' },
      null,
      expect.anything(),
    )
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'n2',
      ok: true,
      result: { ref: { windowId: 5, localId: 'fresh' } },
    })
  })

  it('opens a recent-only remote workspace and creates the session in its window', async () => {
    const folder = 'remote-ssh://wsl+ubuntu-24.04/home/dev/project'
    const authority = 'wsl+ubuntu-24.04'
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [{ folder, name: 'project', authority }]),
      waitForBridge: vi.fn(async () => 7),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.newSession.mockResolvedValueOnce({ ok: true, value: { localId: 'remote-fresh' } })
    hub.registerWindow(7, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n-remote',
      kind: 'newSession',
      payload: {
        agentId: 'fake',
        workspace: { folder, authority },
      },
    })

    expect(host.openWorkspace).toHaveBeenCalledWith(folder, authority)
    expect(host.waitForBridge).toHaveBeenCalledWith(folder, authority, expect.any(Number))
    expect(bridge.newSession).toHaveBeenCalledWith(
      'fake',
      { folder, authority },
      null,
      expect.anything(),
    )
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'n-remote',
      ok: true,
      result: { ref: { windowId: 7, localId: 'remote-fresh' } },
    })
  })

  it('pings until the freshly opened window renderer answers', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
      waitForBridge: vi.fn(async () => 5),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.ping
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
      .mockRejectedValueOnce(new Error('ChannelNotFoundError'))
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n2b',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/recent' } },
    })

    expect(bridge.ping).toHaveBeenCalledTimes(3)
    expect(bridge.newSession).toHaveBeenCalledTimes(1)
    expect(connection.frames.at(-1)).toMatchObject({ ok: true })
  })

  it('reports workspace_not_open when the renderer bridge never answers', async () => {
    vi.useFakeTimers()
    try {
      const host = makeHost({
        listOpenWorkspaces: vi.fn(() => [
          { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
        ]),
      })
      const hub = new MobileGatewayHub(NULL_LOGGER, host)
      const bridge = new FakeBridge()
      bridge.ping.mockRejectedValue(new Error('not ready'))
      hub.registerWindow(1, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)

      const pending = hub.handleCommand(connection, {
        type: 'command',
        requestId: 'n2c',
        kind: 'newSession',
        payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/demo' } },
      })
      await vi.advanceTimersByTimeAsync(NEW_SESSION_TIMEOUT_MS + 1_000)
      await pending

      expect(bridge.newSession).not.toHaveBeenCalled()
      expect(connection.frames.at(-1)).toMatchObject({
        ok: false,
        error: 'workspace_not_open',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending newSession call when the budget expires', async () => {
    vi.useFakeTimers()
    try {
      const host = makeHost({
        listOpenWorkspaces: vi.fn(() => [
          { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
        ]),
      })
      const hub = new MobileGatewayHub(NULL_LOGGER, host)
      const bridge = new FakeBridge()
      bridge.newSession.mockImplementationOnce(() => new Promise(() => {}))
      hub.registerWindow(1, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)

      const pending = hub.handleCommand(connection, {
        type: 'command',
        requestId: 'n-timeout',
        kind: 'newSession',
        payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/demo' } },
      })
      await vi.advanceTimersByTimeAsync(NEW_SESSION_TIMEOUT_MS + 1_000)
      await pending

      const token = (bridge.newSession.mock.calls[0] as unknown[] | undefined)?.[3] as
        | CancellationToken
        | undefined
      expect(token?.isCancellationRequested).toBe(true)
      expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'internal' })
    } finally {
      vi.useRealTimers()
    }
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
    expect(remoteHost.openWorkspace).toHaveBeenCalledWith('remote-ssh://host/workspace', 'host')
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
        { folder: 'file:///workspace/open', name: 'open', isOpen: true, windowId: 1 },
        { folder: 'file:///workspace/older', name: 'older', isOpen: false },
      ],
    })
  })

  it('annotates known git state and keeps unknown candidates bare', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/open', name: 'open' },
      ]),
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/clean', name: 'clean' },
        { folder: 'remote-ssh://host/remote', name: 'remote', authority: 'host' },
      ]),
      workspaceGitDirty: vi.fn(async (workspace) => {
        if (workspace.folder.endsWith('/open')) return true
        if (workspace.folder.endsWith('/clean')) return false
        return undefined
      }),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w2',
      kind: 'listWorkspaces',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'w2',
      ok: true,
      result: [
        {
          folder: 'file:///workspace/open',
          name: 'open',
          isOpen: true,
          windowId: 1,
          gitDirty: true,
        },
        { folder: 'file:///workspace/clean', name: 'clean', isOpen: false, gitDirty: false },
        { folder: 'remote-ssh://host/remote', name: 'remote', authority: 'host', isOpen: false },
      ],
    })
  })

  it('passes the ready bridge to remote open candidates', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'remote-ssh://host/repo', name: 'repo', authority: 'host' },
      ]),
      workspaceGitDirty: vi.fn(async (_workspace, bridge) =>
        bridge === undefined ? undefined : bridge.getWorkspaceGitDirty(),
      ),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)

    const bridge = new FakeBridge()
    bridge.getWorkspaceGitDirty.mockResolvedValueOnce(true)
    hub.registerWindow(1, bridge, () => 'repo')
    // The ready probe must finish before the gateway trusts the bridge.
    await vi.waitFor(() => expect(bridge.startStreaming).toHaveBeenCalled())

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w3',
      kind: 'listWorkspaces',
      payload: {},
    })
    const frame = connection.frames.find(
      (candidate) => candidate.type === 'command_result' && candidate.requestId === 'w3',
    )
    expect(frame).toMatchObject({
      type: 'command_result',
      requestId: 'w3',
      ok: true,
      result: [
        {
          folder: 'remote-ssh://host/repo',
          name: 'repo',
          authority: 'host',
          isOpen: true,
          windowId: 1,
          gitDirty: true,
        },
      ],
    })
    expect(bridge.getWorkspaceGitDirty).toHaveBeenCalledTimes(1)
  })

  it('keeps the list when one probe fails', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/a', name: 'a' },
        { folder: 'file:///workspace/b', name: 'b' },
      ]),
      workspaceGitDirty: vi.fn(async (workspace) => {
        if (workspace.folder.endsWith('/a')) throw new Error('boom')
        return true
      }),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w4',
      kind: 'listWorkspaces',
      payload: {},
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'w4',
      ok: true,
      result: [
        { folder: 'file:///workspace/a', name: 'a', isOpen: false },
        { folder: 'file:///workspace/b', name: 'b', isOpen: false, gitDirty: true },
      ],
    })
  })

  it('probes every open window and caps only recent candidates', async () => {
    const open = Array.from({ length: MAX_GIT_STATUS_CANDIDATES + 1 }, (_, index) => ({
      windowId: index + 1,
      folder: `file:///workspace/open-${index}`,
      name: `open-${index}`,
    }))
    const recent = Array.from({ length: 5 }, (_, index) => ({
      folder: `file:///workspace/recent-${index}`,
      name: `recent-${index}`,
    }))
    const probe = vi.fn(async () => true)
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => open),
      listRecentWorkspaces: vi.fn(async () => recent),
      workspaceGitDirty: probe,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w5',
      kind: 'listWorkspaces',
      payload: {},
    })
    expect(probe).toHaveBeenCalledTimes(MAX_GIT_STATUS_CANDIDATES + 1)
    const frame = connection.frames.at(-1) as {
      result: readonly Record<string, unknown>[]
    }
    expect(
      frame.result
        .slice(0, MAX_GIT_STATUS_CANDIDATES + 1)
        .every((item) => item['gitDirty'] === true),
    ).toBe(true)
    expect(
      frame.result
        .slice(MAX_GIT_STATUS_CANDIDATES + 1)
        .every((item) => item['gitDirty'] === undefined),
    ).toBe(true)
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

  it('never audits anchor ids, side-task ids or quotes', async () => {
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
        requestId: 'f1',
        kind: 'forkSession',
        payload: { ref, messageId: 'secret-anchor' },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith('forkSession', 'success', 'window=1 local=s1')

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 's1',
        kind: 'createSideTask',
        payload: { ref, quote: 'secret quote' },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith('createSideTask', 'success', 'window=1 local=s1')

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'd1',
        kind: 'deleteSideTask',
        payload: { ref, sideTaskId: 'secret-side' },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith('deleteSideTask', 'success', 'window=1 local=s1')

    const audited = JSON.stringify(vi.mocked(audit.record).mock.calls)
    expect(audited).not.toContain('secret-anchor')
    expect(audited).not.toContain('secret quote')
    expect(audited).not.toContain('secret-side')
  })

  it('does not audit read-only rewind previews or side-task listings', async () => {
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
        kind: 'previewRewind',
        payload: { ref, messageId: 'msg-1' },
      },
      audit,
    )
    await hub.handleCommand(
      connection,
      { type: 'command', requestId: 'l1', kind: 'listSideTasks', payload: { ref } },
      audit,
    )
    expect(audit.record).not.toHaveBeenCalled()
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
      await vi.advanceTimersByTimeAsync(SEND_PROMPT_TIMEOUT_MS + 1)
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

describe('MobileGatewayHub attention mode', () => {
  it('listens for edges without starting the streaming pipeline', async () => {
    const seen: MobileGatewayAttention[] = []
    const hub = new MobileGatewayHub(NULL_LOGGER, undefined, (attention) => seen.push(attention))
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)

    hub.setAttentionNeeded(true)
    await tick()
    expect(bridge.startAttention).toHaveBeenCalledTimes(1)
    expect(bridge.startStreaming).not.toHaveBeenCalled()

    bridge.emit({
      kind: 'attention',
      localId: 's1',
      durableId: 'd1',
      attentionKind: 'permission',
      title: 'Session s1',
      agentName: 'Fake Agent',
      permissionTitle: 'Run shell command',
    })
    expect(seen).toEqual([
      {
        kind: 'permission',
        ref: { windowId: 1, localId: 's1', durableId: 'd1' },
        title: 'Session s1',
        agentName: 'Fake Agent',
        permissionTitle: 'Run shell command',
      },
    ])

    hub.setAttentionNeeded(false)
    await tick()
    expect(bridge.stopAttention).toHaveBeenCalledTimes(1)
  })

  it('keeps streaming when only attention is switched off', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    hub.setAttentionNeeded(true)
    await tick()
    expect(bridge.startAttention).toHaveBeenCalledTimes(1)

    hub.setAttentionNeeded(false)
    await tick()
    expect(bridge.stopAttention).toHaveBeenCalledTimes(1)
    expect(bridge.stopStreaming).not.toHaveBeenCalled()

    hub.removeConnection(connection)
    await tick()
    expect(bridge.stopStreaming).toHaveBeenCalledTimes(1)
  })

  it('prefers the cached inbox title but forwards the bridge details', async () => {
    const seen: MobileGatewayAttention[] = []
    const hub = new MobileGatewayHub(NULL_LOGGER, undefined, (attention) => seen.push(attention))
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { title: 'Inbox title', agentName: 'Inbox Agent' })]
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    bridge.emit({
      kind: 'attention',
      localId: 's1',
      durableId: 'd1',
      attentionKind: 'completed',
      title: 'Bridge title',
      agentName: 'Bridge Agent',
    })
    expect(seen[0]).toMatchObject({
      title: 'Inbox title',
      agentName: 'Inbox Agent',
      ref: { windowId: 1, localId: 's1', durableId: 'd1' },
    })
  })

  it('stops attention when the window closes', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    hub.setAttentionNeeded(true)
    await tick()

    hub.unregisterWindow(1)
    await tick()
    expect(bridge.stopAttention).toHaveBeenCalledTimes(1)
  })
})

describe('MobileGatewayHub attachment resolution', () => {
  const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }
  const resolvedAttachments = [
    {
      kind: 'image' as const,
      id: 'att-1',
      name: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
      dataBase64: 'AAA=',
    },
  ]

  function hostWith(resolver: MobileGatewayHost['attachments']): MobileGatewayHost {
    return {
      listOpenWorkspaces: () => [],
      listRecentWorkspaces: async () => [],
      openWorkspace: async () => {},
      waitForBridge: async () => undefined,
      readWorkspaceSessionHistory: async () => [],
      sessionHistoryWorkspaceLimit: () => 20,
      ...(resolver !== undefined ? { attachments: resolver } : {}),
    }
  }

  function makeHarness(resolver: MobileGatewayHost['attachments']) {
    const hub = new MobileGatewayHub(NULL_LOGGER, hostWith(resolver))
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    return { hub, bridge, connection }
  }

  const command = {
    type: 'command' as const,
    requestId: 'a1',
    kind: 'sendPrompt',
    payload: { ref, text: '', attachmentIds: ['att-1'] },
  }

  it('resolves ids for the authenticated device and consumes them after success', async () => {
    const resolveForPrompt = vi.fn(async () => resolvedAttachments)
    const consume = vi.fn(async () => {})
    const { hub, bridge, connection } = makeHarness({ resolveForPrompt, consume })

    await hub.handleCommand(connection, command, undefined, { deviceId: 'dev-1' })

    expect(resolveForPrompt).toHaveBeenCalledWith('dev-1', ['att-1'])
    expect(bridge.sendPrompt).toHaveBeenCalledWith('s1', '', resolvedAttachments)
    await tick()
    expect(consume).toHaveBeenCalledWith('dev-1', ['att-1'])
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'a1',
      ok: true,
    })
  })

  it('rejects attachment ids when the connection has no device identity', async () => {
    const resolveForPrompt = vi.fn(async () => resolvedAttachments)
    const { hub, bridge, connection } = makeHarness({ resolveForPrompt, consume: vi.fn() })

    await hub.handleCommand(connection, command)

    expect(resolveForPrompt).not.toHaveBeenCalled()
    expect(bridge.sendPrompt).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'unauthorized' })
  })

  it('reports not_supported when the host has no attachment store', async () => {
    const { hub, bridge, connection } = makeHarness(undefined)

    await hub.handleCommand(connection, command, undefined, { deviceId: 'dev-1' })

    expect(bridge.sendPrompt).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'not_supported' })
  })

  it('maps store errors onto mobile error codes and does not consume', async () => {
    const consume = vi.fn(async () => {})
    const resolveForPrompt = vi.fn(async () => {
      throw new MobileAttachmentError('attachment_not_found', 'gone')
    })
    const { hub, bridge, connection } = makeHarness({ resolveForPrompt, consume })

    await hub.handleCommand(connection, command, undefined, { deviceId: 'dev-1' })

    expect(bridge.sendPrompt).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toMatchObject({
      ok: false,
      error: 'attachment_not_found',
    })
    await tick()
    expect(consume).not.toHaveBeenCalled()
  })

  it('keeps the command successful when the post-send consume fails', async () => {
    const resolveForPrompt = vi.fn(async () => resolvedAttachments)
    const consume = vi.fn(async () => {
      throw new Error('disk gone')
    })
    const { hub, bridge, connection } = makeHarness({ resolveForPrompt, consume })

    await hub.handleCommand(connection, command, undefined, { deviceId: 'dev-1' })
    await tick()

    expect(bridge.sendPrompt).toHaveBeenCalled()
    expect(consume).toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'a1',
      ok: true,
    })
  })

  it('forwards imageSupported through the protocol summary', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1', imageSupported: true })]
    bridge.snapshots.set(
      's1',
      snapshot('s1', {
        summary: summary('s1', { durableId: 'd1', imageSupported: true }),
      }),
    )
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.subscribeSession(connection, ref)

    const frame = framesOf(connection, 'session_snapshot')[0]
    expect(frame?.session.summary.imageSupported).toBe(true)
  })

  it('reads image bytes through the owning window bridge', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    const image = { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
    bridge.getMessageImage.mockResolvedValue(image)
    bridge.getWorkspaceImage.mockResolvedValue(image)
    hub.registerWindow(1, bridge)

    const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }
    await expect(hub.readSessionImage(ref, 'm1', 0)).resolves.toEqual(image)
    expect(bridge.getMessageImage).toHaveBeenCalledWith('s1', 'm1', 0, expect.anything())

    await expect(hub.readSessionWorkspaceImage(ref, 'img/a.png')).resolves.toEqual(image)
    expect(bridge.getWorkspaceImage).toHaveBeenCalledWith('s1', 'img/a.png', expect.anything())

    await expect(
      hub.readSessionImage({ windowId: 9, localId: 's1' }, 'm1', 0),
    ).resolves.toBeUndefined()
    await expect(hub.readSessionWorkspaceImage(ref, 'missing.png')).resolves.toEqual(image)
  })
})
