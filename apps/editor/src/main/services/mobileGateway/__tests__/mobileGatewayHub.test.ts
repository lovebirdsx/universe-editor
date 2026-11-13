import { CancellationToken, Emitter, type ILogger } from '@universe-editor/platform'
import {
  DEFAULT_COMMIT_PROMPT_REFS,
  DEFAULT_PROMPT_REF_SUGGESTIONS,
  MAX_SERVER_FRAME_BYTES,
  MAX_WORKSPACE_NAME_LENGTH,
  type MobileAgentCandidate,
  type MobileDeliveryDetail,
  type MobileDeliveryPreview,
  type MobileDeliveryStartResult,
  type MobilePromptRef,
  type MobilePromptRefSuggestion,
  type MobilePushBranchPreview,
  type MobilePushBranchResult,
  type MobileSessionRef,
  type MobileSessionSettings,
  type MobileSideTaskSummary,
  type MobileWorkspaceCandidate,
  type ResolvePromptRefRequest,
  type ResolvePromptRefResult,
  type DraftUpdateFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { describe, expect, it, vi } from 'vitest'
import type {
  IMobileBridgeService,
  MobileBridgeDeliveryContext,
  MobileBridgeEvent,
  MobileBridgeImage,
  MobileBridgeNewSessionResult,
  MobileBridgePromptAttachment,
  MobileBridgeResult,
  MobileBridgeSessionEvent,
  MobileBridgeSessionHistoryEntry,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
} from '../../../../shared/ipc/mobileGatewayService.js'
import { MobileAttachmentError } from '../mobileAttachmentStore.js'
import { WorkspaceDirectoryBrowseError } from '../workspaceDirectoryBrowser.js'
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
  readonly getAutomationRunId = vi.fn(async (): Promise<string | undefined> => undefined)
  readonly ping = vi.fn(async () => 'pong' as const)
  readonly getWorkspaceGitDirty = vi.fn(async (): Promise<boolean | undefined> => undefined)
  readonly applyDraft = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly noteDraftRevision = vi.fn(async () => {})
  readonly ackDraftRevision = vi.fn(async () => {})
  readonly getDraftImage = vi.fn(async (): Promise<MobileBridgeImage | undefined> => undefined)
  readonly attachDraftAttachments = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resolveDraftAttachments = vi.fn(
    async (): Promise<MobileBridgeResult<readonly MobileBridgePromptAttachment[]>> => ({
      ok: true,
      value: [],
    }),
  )
  readonly clearDraft = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly sendPrompt = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly searchPromptRefs = vi.fn(
    async (): Promise<MobileBridgeResult<readonly MobilePromptRefSuggestion[]>> => ({
      ok: true,
      value: [],
    }),
  )
  readonly resolvePromptRef = vi.fn(
    async (
      _localId: string,
      request: ResolvePromptRefRequest,
    ): Promise<MobileBridgeResult<ResolvePromptRefResult>> =>
      request.kind === 'commit'
        ? { ok: true, value: { kind: 'commit', entries: [] } }
        : { ok: true, value: { kind: 'chatContext' } },
  )
  readonly cancelTurn = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resolvePermission = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly cancelPermission = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resolveElicitation = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly setConfigOption = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly getSessionSettings = vi.fn(
    async (): Promise<MobileBridgeResult<MobileSessionSettings>> => ({
      ok: true,
      value: {
        canEdit: true,
        subagentModel: { supported: false, current: null, candidates: [] },
        mcp: { pool: [], selection: null, enabled: [], live: [] },
      },
    }),
  )
  readonly setSubagentModel = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly restartAgentProcess = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly setSessionMcpServers = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly pauseAutoResolve = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly resumeAutoResolve = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly newSession = vi.fn(async () => ({
    ok: true as const,
    value: { localId: 'new-local' },
  }))
  readonly renameSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly closeSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly deleteSession = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly deleteHistorySession = vi.fn(
    async (): Promise<MobileBridgeResult<void>> => ({ ok: true, value: undefined }),
  )
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
  readonly previewDelivery = vi.fn(
    async (): Promise<MobileBridgeResult<MobileDeliveryPreview>> => ({
      ok: false as const,
      code: 'internal' as const,
      message: 'not implemented',
    }),
  )
  readonly startDelivery = vi.fn(
    async (): Promise<MobileBridgeResult<MobileDeliveryStartResult>> => ({
      ok: false as const,
      code: 'internal' as const,
      message: 'not implemented',
    }),
  )
  readonly getDelivery = vi.fn(
    async (): Promise<MobileBridgeResult<MobileDeliveryDetail>> => ({
      ok: false as const,
      code: 'internal' as const,
      message: 'not implemented',
    }),
  )
  readonly confirmDeliveryPush = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly retryDelivery = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly undoDelivery = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly openDeliveryMainWorktree = vi.fn(async () => ({ ok: true as const, value: undefined }))
  readonly previewPushBranch = vi.fn(
    async (): Promise<MobileBridgeResult<MobilePushBranchPreview>> => ({
      ok: false as const,
      code: 'internal' as const,
      message: 'not implemented',
    }),
  )
  readonly pushBranch = vi.fn(
    async (): Promise<MobileBridgeResult<MobilePushBranchResult>> => ({
      ok: false as const,
      code: 'internal' as const,
      message: 'not implemented',
    }),
  )
  readonly getDeliveryContext = vi.fn(
    async (): Promise<MobileBridgeDeliveryContext | undefined> => undefined,
  )
  readonly listActiveDeliveries = vi.fn(
    async (): Promise<readonly MobileBridgeDeliveryContext[]> => [],
  )
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
    options: Array<{ optionId: string; kind?: string }>,
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
    bridge.history = [historyRow('d1')]
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
      ['setSubagentModel', { ref, model: 'opus' }, bridge.setSubagentModel],
      ['restartAgentProcess', { ref }, bridge.restartAgentProcess],
      ['setSessionMcpServers', { ref, servers: ['shared'] }, bridge.setSessionMcpServers],
      ['pauseAutoResolve', { ref, requestId: 'req-1' }, bridge.pauseAutoResolve],
      ['resumeAutoResolve', { ref, requestId: 'req-1' }, bridge.resumeAutoResolve],
      ['renameSession', { ref, title: 'Renamed' }, bridge.renameSession],
      ['closeSession', { ref }, bridge.closeSession],
      ['deleteSession', { ref }, bridge.deleteSession],
      ['deleteHistorySession', { durableId: 'd1' }, bridge.deleteHistorySession],
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
    expect(bridge.setSubagentModel).toHaveBeenCalledWith('s1', 'opus')
    expect(bridge.restartAgentProcess).toHaveBeenCalledWith('s1')
    expect(bridge.setSessionMcpServers).toHaveBeenCalledWith('s1', ['shared'])
  })

  it('routes getSessionSettings and returns the projected settings', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'settings-1',
      kind: 'getSessionSettings',
      payload: { ref },
    })

    expect(bridge.getSessionSettings).toHaveBeenCalledWith('s1')
    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    expect(frame).toMatchObject({ type: 'command_result', ok: true, requestId: 'settings-1' })
    expect(frame.result).toEqual({
      canEdit: true,
      subagentModel: { supported: false, current: null, candidates: [] },
      mcp: { pool: [], selection: null, enabled: [], live: [] },
    })
  })

  it('audits the new mutating commands but not the settings query, and caches writes', async () => {
    const audit: MobileCommandAudit = { record: vi.fn() }
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(
      connection,
      { type: 'command', requestId: 'read-1', kind: 'getSessionSettings', payload: { ref } },
      audit,
    )
    expect(audit.record).not.toHaveBeenCalled()

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'write-sub-1',
        kind: 'setSubagentModel',
        payload: { ref, model: 'opus' },
        idempotencyKey: 'sub-key',
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith(
      'setSubagentModel',
      'success',
      'window=1 local=s1',
    )

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'write-sub-2',
        kind: 'setSubagentModel',
        payload: { ref, model: 'opus' },
        idempotencyKey: 'sub-key',
      },
      audit,
    )
    expect(bridge.setSubagentModel).toHaveBeenCalledTimes(1)

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'write-restart-1',
        kind: 'restartAgentProcess',
        payload: { ref },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith(
      'restartAgentProcess',
      'success',
      'window=1 local=s1',
    )

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'write-mcp-1',
        kind: 'setSessionMcpServers',
        payload: { ref, servers: ['shared'] },
      },
      audit,
    )
    expect(audit.record).toHaveBeenLastCalledWith(
      'setSessionMcpServers',
      'success',
      'window=1 local=s1',
    )
  })

  it('routes prompt-ref completion, applies the default limit and clamps entries', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    bridge.searchPromptRefs.mockResolvedValue({
      ok: true,
      value: [
        { kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts' },
        { kind: 'file', label: 'x'.repeat(600), uri: 'file:///w/big' },
        {
          kind: 'nope',
          label: 'bad',
          uri: 'file:///w/bad',
        } as unknown as MobilePromptRefSuggestion,
        { kind: 'docs', label: 'Docs', uri: 'file:///docs' },
      ],
    })

    for (let round = 0; round < 2; round += 1) {
      await hub.handleCommand(connection, {
        type: 'command',
        requestId: `search-${round}`,
        kind: 'searchPromptRefs',
        payload: { ref, trigger: '@', query: 'src' },
        idempotencyKey: 'same-key',
      })
    }

    // Read-only commands must not be served from the idempotency cache.
    expect(bridge.searchPromptRefs).toHaveBeenCalledTimes(2)
    expect(bridge.searchPromptRefs).toHaveBeenCalledWith(
      's1',
      '@',
      'src',
      DEFAULT_PROMPT_REF_SUGGESTIONS,
    )
    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    expect(frame).toMatchObject({ type: 'command_result', requestId: 'search-1', ok: true })
    const entries = (frame.result as { entries: readonly MobilePromptRefSuggestion[] }).entries
    // Overlong identity fields, unknown kinds and docs without dirPath are
    // dropped, never truncated: a clipped token could not be sent back.
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'file',
      label: 'src/a.ts',
      uri: 'file:///w/src/a.ts',
    })
  })

  it('keeps commit and chatContext search entries while dropping malformed ones', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    bridge.searchPromptRefs.mockResolvedValue({
      ok: true,
      value: [
        { kind: 'commit', label: 'Git Commit…', uri: '', description: 'Pick a commit' },
        { kind: 'chatContext', label: 'Perforce CL', uri: '', chatContextHandle: 3 },
        { kind: 'chatContext', label: 'No handle', uri: '' },
        { kind: 'chatContext', label: 'Has uri', uri: 'file:///w', chatContextHandle: 4 },
        { kind: 'commit', label: 'Has uri', uri: 'file:///w' },
      ],
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'search-context',
      kind: 'searchPromptRefs',
      payload: { ref, trigger: '#', query: '' },
    })

    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    const entries = (frame.result as { entries: readonly MobilePromptRefSuggestion[] }).entries
    expect(entries).toEqual([
      { kind: 'commit', label: 'Git Commit…', uri: '', description: 'Pick a commit' },
      { kind: 'chatContext', label: 'Perforce CL', uri: '', chatContextHandle: 3 },
    ])
  })

  it('clamps search entries to the requested limit', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    bridge.searchPromptRefs.mockResolvedValue({
      ok: true,
      value: [
        { kind: 'file', label: 'a.ts', uri: 'file:///w/a.ts' },
        { kind: 'file', label: 'b.ts', uri: 'file:///w/b.ts' },
        { kind: 'file', label: 'c.ts', uri: 'file:///w/c.ts' },
      ],
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'search-limit',
      kind: 'searchPromptRefs',
      payload: { ref, trigger: '@', query: '', limit: 2 },
    })

    expect(bridge.searchPromptRefs).toHaveBeenCalledWith('s1', '@', '', 2)
    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    const entries = (frame.result as { entries: readonly MobilePromptRefSuggestion[] }).entries
    expect(entries.map((entry) => entry.label)).toEqual(['a.ts', 'b.ts'])
  })

  it('routes commit resolution with the default limit and clamps entries', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    const hash = 'a'.repeat(40)
    bridge.resolvePromptRef.mockResolvedValue({
      ok: true,
      value: {
        kind: 'commit',
        entries: [
          {
            kind: 'commit',
            label: 'a1b2c3d fix',
            uri: 'file:///w/repo',
            commitHash: hash,
            text: 'fix',
            description: 'Alice',
          },
          { kind: 'commit', label: 'bad', uri: 'file:///w/repo', commitHash: 'nope', text: 'bad' },
          { kind: 'chatContext', label: 'cross-kind', uri: '', text: 'x' },
        ],
      },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'resolve-commit',
      kind: 'resolvePromptRef',
      payload: { ref, kind: 'commit', query: 'fix' },
      idempotencyKey: 'resolve-key',
    })

    expect(bridge.resolvePromptRef).toHaveBeenCalledWith('s1', {
      kind: 'commit',
      query: 'fix',
      limit: DEFAULT_COMMIT_PROMPT_REFS,
    })
    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    expect(frame).toMatchObject({ type: 'command_result', ok: true, requestId: 'resolve-commit' })
    expect(frame.result).toEqual({
      kind: 'commit',
      entries: [
        {
          kind: 'commit',
          label: 'a1b2c3d fix',
          uri: 'file:///w/repo',
          commitHash: hash,
          text: 'fix',
          description: 'Alice',
        },
      ],
    })
  })

  it('serves repeated resolvePromptRef idempotency keys from the cache', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    for (let round = 0; round < 2; round += 1) {
      await hub.handleCommand(connection, {
        type: 'command',
        requestId: `resolve-${round}`,
        kind: 'resolvePromptRef',
        payload: { ref, kind: 'commit', query: 'fix', limit: 1 },
        idempotencyKey: 'same-resolve-key',
      })
    }

    expect(bridge.resolvePromptRef).toHaveBeenCalledTimes(1)
    expect(bridge.resolvePromptRef).toHaveBeenCalledWith('s1', {
      kind: 'commit',
      query: 'fix',
      limit: 1,
    })
  })

  it('routes chatContext resolution and clamps the returned item', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    bridge.resolvePromptRef.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'chatContext',
        entry: {
          kind: 'chatContext',
          label: 'CL 123',
          uri: '',
          text: 'Change 123\n- src/a.ts',
          description: 'Perforce',
        },
      },
    })
    bridge.resolvePromptRef.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'chatContext',
        entry: { kind: 'chatContext', label: 'CL 9', uri: 'file:///w', text: 'x' },
      },
    })

    for (let round = 0; round < 2; round += 1) {
      await hub.handleCommand(connection, {
        type: 'command',
        requestId: `resolve-chat-${round}`,
        kind: 'resolvePromptRef',
        payload: { ref, kind: 'chatContext', query: '', handle: 4, label: 'Perforce CL' },
        idempotencyKey: `resolve-chat-key-${round}`,
      })
    }

    expect(bridge.resolvePromptRef).toHaveBeenCalledWith('s1', {
      kind: 'chatContext',
      query: '',
      handle: 4,
      label: 'Perforce CL',
    })
    const [first, second] = connection.frames
      .filter(
        (candidate): candidate is Extract<ServerFrame, { type: 'command_result' }> =>
          candidate.type === 'command_result',
      )
      .slice(-2)
    expect(first?.result).toEqual({
      kind: 'chatContext',
      entry: {
        kind: 'chatContext',
        label: 'CL 123',
        uri: '',
        text: 'Change 123\n- src/a.ts',
        description: 'Perforce',
      },
    })
    expect(second?.result).toEqual({ kind: 'chatContext' })
  })

  it('caps commit entries at the requested limit', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    const entry = (hash: string) => ({
      kind: 'commit' as const,
      label: `${hash.slice(0, 7)} subject`,
      uri: 'file:///w/repo',
      commitHash: hash,
      text: 'subject',
    })
    bridge.resolvePromptRef.mockResolvedValue({
      ok: true,
      value: { kind: 'commit', entries: [entry('a'.repeat(40)), entry('b'.repeat(40))] },
    })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'resolve-limit',
      kind: 'resolvePromptRef',
      payload: { ref, kind: 'commit', query: '', limit: 1 },
      idempotencyKey: 'resolve-limit-key',
    })

    const frame = connection.frames.at(-1) as Extract<ServerFrame, { type: 'command_result' }>
    expect((frame.result as { entries: readonly unknown[] }).entries).toHaveLength(1)
  })

  it('forwards structured prompt refs to the bridge', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    const refs: MobilePromptRef[] = [
      { kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts', start: 8, end: 17 },
    ]

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'send',
      kind: 'sendPrompt',
      payload: { ref, text: 'look at @src/a.ts', refs },
    })

    expect(bridge.sendPrompt).toHaveBeenCalledWith('s1', 'look at @src/a.ts', [], refs)
  })

  it('deletes a history row from every open window that owns it', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    const third = new FakeBridge()
    first.history = [historyRow('d1')]
    second.history = [historyRow('d1')]
    hub.registerWindow(1, first)
    hub.registerWindow(2, second)
    hub.registerWindow(3, third)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete-history',
      kind: 'deleteHistorySession',
      payload: { durableId: 'd1', windowId: 2 },
    })

    expect(first.deleteHistorySession).toHaveBeenCalledWith('d1')
    expect(second.deleteHistorySession).toHaveBeenCalledWith('d1')
    expect(third.deleteHistorySession).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'delete-history',
      ok: true,
    })
  })

  it('reports session_not_found when no open window owns the history row', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete-history',
      kind: 'deleteHistorySession',
      payload: { durableId: 'missing' },
    })

    expect(bridge.deleteHistorySession).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'delete-history',
      ok: false,
      error: 'session_not_found',
    })
  })

  it('uses the live delete path when the PC resumed the row first', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete-history',
      kind: 'deleteHistorySession',
      payload: { durableId: 'd1', windowId: 1 },
    })

    expect(bridge.deleteSession).toHaveBeenCalledWith('s1')
    expect(bridge.deleteHistorySession).not.toHaveBeenCalled()
  })

  it('succeeds when at least one owner deletes the row and reports a hard failure otherwise', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const first = new FakeBridge()
    const second = new FakeBridge()
    first.history = [historyRow('d1')]
    second.history = [historyRow('d1')]
    first.deleteHistorySession.mockResolvedValueOnce({
      ok: false,
      code: 'session_not_found',
      message: 'already gone',
    })
    hub.registerWindow(1, first)
    hub.registerWindow(2, second)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete-history',
      kind: 'deleteHistorySession',
      payload: { durableId: 'd1' },
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'delete-history',
      ok: true,
    })

    first.deleteHistorySession.mockResolvedValue({
      ok: false,
      code: 'session_read_only',
      message: 'read-only',
    })
    second.deleteHistorySession.mockResolvedValue({
      ok: false,
      code: 'session_read_only',
      message: 'read-only',
    })
    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'delete-history-again',
      kind: 'deleteHistorySession',
      payload: { durableId: 'd1' },
    })
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'delete-history-again',
      ok: false,
      error: 'session_read_only',
    })
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
    await subscribeWithPermission(hub, bridge, connection, [{ optionId: 'allow-once' }])

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
    await subscribeWithPermission(hub, bridge, connection, [{ optionId: 'allow-once' }])
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

  it('rejects a permission option the gateway never offered', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const connection = makeConnection()
    await subscribeWithPermission(hub, bridge, connection, [{ optionId: 'allow-once' }])

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'unoffered',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'never-offered' },
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

  it('routes bypass and full-access config values like any other value', async () => {
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
    expect(bridge.setConfigOption).toHaveBeenCalledWith('s1', 'approval', 'bypassPermissions')
    expect(connection.frames.at(-1)).toMatchObject({ ok: true })

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'mode',
      kind: 'setConfigOption',
      payload: { ref, configId: 'mode', value: 'code' },
    })
    expect(bridge.setConfigOption).toHaveBeenCalledWith('s1', 'mode', 'code')
  })

  it('sends bypass and durable options to every connection and routes them', async () => {
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
            options: [
              { value: 'ask', label: 'Ask' },
              { value: 'bypassPermissions', label: 'Bypass' },
            ],
          },
        ],
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'Run command',
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
          ],
        },
      }),
    )
    hub.registerWindow(1, bridge)
    const first = makeConnection()
    const second = makeConnection()
    hub.addConnection(first)
    hub.addConnection(second)
    hub.authenticateConnection(first, 'd-first')
    hub.authenticateConnection(second, 'd-second')
    await hub.subscribeSession(first, ref)
    await hub.subscribeSession(second, ref)

    for (const snapshotFrame of [
      framesOf(first, 'session_snapshot')[0]?.session,
      framesOf(second, 'session_snapshot')[0]?.session,
    ]) {
      expect(snapshotFrame?.configOptions[0]?.options).toEqual([
        { value: 'ask', label: 'Ask' },
        { value: 'bypassPermissions', label: 'Bypass' },
      ])
      expect(snapshotFrame?.pendingPermission?.options).toEqual([
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
      ])
      expect(snapshotFrame?.configOptions[0]).not.toHaveProperty('allowedOnMobile')
    }

    await hub.handleCommand(first, {
      type: 'command',
      requestId: 'durable',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-always' },
    })
    expect(bridge.resolvePermission).toHaveBeenCalledWith('s1', 'req-1', 'allow-always', undefined)
    expect(first.frames.at(-1)).toMatchObject({ ok: true })
  })

  it('forwards session deltas unchanged and caches every offered option', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const first = makeConnection()
    const second = makeConnection()
    hub.addConnection(first)
    hub.addConnection(second)
    await hub.subscribeSession(first, ref)
    await hub.subscribeSession(second, ref)

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
                options: [
                  { value: 'ask', label: 'Ask' },
                  { value: 'bypassPermissions', label: 'Bypass' },
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
              options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }],
            },
          },
        ],
      }),
    )

    const firstEvents = framesOf(first, 'session_delta').at(-1)?.events
    const secondEvents = framesOf(second, 'session_delta').at(-1)?.events
    expect(firstEvents).toEqual(secondEvents)
    expect(firstEvents?.[0]).toMatchObject({
      type: 'config_options_snapshot',
      options: [{ options: [{ value: 'ask' }, { value: 'bypassPermissions' }] }],
    })
    expect(firstEvents?.[1]).toMatchObject({
      type: 'permission_upsert',
      permission: { options: [{ optionId: 'allow-always' }] },
    })

    await hub.handleCommand(second, {
      type: 'command',
      requestId: 'durable',
      kind: 'resolvePermission',
      payload: { ref, requestId: 'req-1', optionId: 'allow-always' },
    })
    expect(bridge.resolvePermission).toHaveBeenCalledWith('s1', 'req-1', 'allow-always', undefined)
    expect(second.frames.at(-1)).toMatchObject({ ok: true })
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

  it('hands the bridge the matched workspace spelling instead of the phone variation', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent/', name: 'recent' },
      ]),
      waitForBridge: vi.fn(async () => 5),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    bridge.newSession.mockResolvedValueOnce({ ok: true, value: { localId: 'canonical' } })
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n-canonical',
      kind: 'newSession',
      payload: { agentId: 'fake', workspace: { folder: 'file:///workspace/recent' } },
    })

    expect(host.openWorkspace).toHaveBeenCalledWith('file:///workspace/recent/', undefined)
    expect(host.waitForBridge).toHaveBeenCalledWith(
      'file:///workspace/recent/',
      undefined,
      expect.any(Number),
    )
    expect(bridge.newSession).toHaveBeenCalledWith(
      'fake',
      { folder: 'file:///workspace/recent/' },
      null,
      expect.anything(),
    )
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

  it('lists a directory in an open workspace without opening a window', async () => {
    const listing = {
      relativePath: 'packages',
      parentRelativePath: '',
      entries: [{ name: 'ui', relativePath: 'packages/ui' }],
    }
    const listDirectory = vi.fn(async () => listing)
    const audit: MobileCommandAudit = { record: vi.fn() }
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      listDirectory,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'dir-1',
        kind: 'listDirectory',
        payload: { folder: 'file:///workspace/demo', relativePath: 'packages' },
      },
      audit,
    )

    expect(listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'file:///workspace/demo' }),
      'packages',
    )
    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(host.waitForBridge).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'dir-1',
      ok: true,
      result: listing,
    })
    // Read-only browsing is not audited.
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('lists a recent-only workspace without opening it', async () => {
    const listDirectory = vi.fn(async () => ({ relativePath: '', entries: [] }))
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
      listDirectory,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'dir-2',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/recent' },
    })

    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(listDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'file:///workspace/recent' }),
      undefined,
    )
    expect(connection.frames.at(-1)).toMatchObject({ ok: true })
  })

  it('rejects directory listings for unknown or invalid targets', async () => {
    const listDirectory = vi.fn(async () => ({ relativePath: '', entries: [] }))
    const host = makeHost({ listDirectory })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'dir-3',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/unknown' },
    })
    expect(connection.frames.at(-1)).toMatchObject({
      ok: false,
      error: 'workspace_not_open',
    })
    expect(listDirectory).not.toHaveBeenCalled()

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'dir-4',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/unknown', relativePath: '../outside' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'bad_request' })
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it('reports not_supported when the host cannot browse directories', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'dir-5',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/demo' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'not_supported' })
  })

  it('maps directory browse failures to bad_request or internal', async () => {
    const badHost = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      listDirectory: vi.fn(async () => {
        throw new WorkspaceDirectoryBrowseError('bad_request', 'missing')
      }),
    })
    const badHub = new MobileGatewayHub(NULL_LOGGER, badHost)
    const badConnection = makeConnection()
    badHub.addConnection(badConnection)
    await badHub.handleCommand(badConnection, {
      type: 'command',
      requestId: 'dir-6',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/demo' },
    })
    expect(badConnection.frames.at(-1)).toMatchObject({ ok: false, error: 'bad_request' })

    const brokenHost = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      listDirectory: vi.fn(async () => {
        throw new Error('provider exploded')
      }),
    })
    const brokenHub = new MobileGatewayHub(NULL_LOGGER, brokenHost)
    const brokenConnection = makeConnection()
    brokenHub.addConnection(brokenConnection)
    await brokenHub.handleCommand(brokenConnection, {
      type: 'command',
      requestId: 'dir-7',
      kind: 'listDirectory',
      payload: { folder: 'file:///workspace/demo' },
    })
    expect(brokenConnection.frames.at(-1)).toMatchObject({ ok: false, error: 'internal' })
  })

  it('returns new-session options for an open workspace without opening a window', async () => {
    const options = { lastRelativePath: 'packages/demo', projectRoots: ['packages/demo'] }
    const readNewSessionOptions = vi.fn(async () => options)
    const audit: MobileCommandAudit = { record: vi.fn() }
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      readNewSessionOptions,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'options-1',
        kind: 'getNewSessionOptions',
        payload: { folder: 'file:///workspace/demo' },
      },
      audit,
    )

    expect(readNewSessionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'file:///workspace/demo' }),
    )
    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(host.waitForBridge).not.toHaveBeenCalled()
    expect(connection.frames.at(-1)).toStrictEqual({
      type: 'command_result',
      requestId: 'options-1',
      ok: true,
      result: options,
    })
    // Read-only defaults are not audited and ignore idempotency keys.
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('returns new-session options for a recent-only workspace', async () => {
    const readNewSessionOptions = vi.fn(async () => ({ projectRoots: [] }))
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
      readNewSessionOptions,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'options-2',
      kind: 'getNewSessionOptions',
      payload: { folder: 'file:///workspace/recent' },
    })

    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(readNewSessionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'file:///workspace/recent' }),
    )
    expect(connection.frames.at(-1)).toMatchObject({ ok: true, result: { projectRoots: [] } })
  })

  it('rejects new-session options for unknown workspaces', async () => {
    const readNewSessionOptions = vi.fn(async () => ({ projectRoots: [] }))
    const host = makeHost({ readNewSessionOptions })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'options-3',
      kind: 'getNewSessionOptions',
      payload: { folder: 'file:///workspace/unknown' },
    })

    expect(connection.frames.at(-1)).toMatchObject({
      ok: false,
      error: 'workspace_not_open',
    })
    expect(readNewSessionOptions).not.toHaveBeenCalled()
  })

  it('reports not_supported when the host cannot read new-session options', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'options-4',
      kind: 'getNewSessionOptions',
      payload: { folder: 'file:///workspace/demo' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'not_supported' })
  })

  it('maps new-session option read failures to internal', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      readNewSessionOptions: vi.fn(async () => {
        throw new Error('provider exploded')
      }),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'options-5',
      kind: 'getNewSessionOptions',
      payload: { folder: 'file:///workspace/demo' },
    })
    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'internal' })
  })

  it('does not cache read-only new-session options by idempotency key', async () => {
    const readNewSessionOptions = vi.fn(async () => ({ projectRoots: [] }))
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/demo', name: 'demo' },
      ]),
      readNewSessionOptions,
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    for (const requestId of ['options-6', 'options-7']) {
      await hub.handleCommand(connection, {
        type: 'command',
        requestId,
        idempotencyKey: 'same-key',
        kind: 'getNewSessionOptions',
        payload: { folder: 'file:///workspace/demo' },
      })
    }
    expect(readNewSessionOptions).toHaveBeenCalledTimes(2)
  })

  it('passes a canonical workspace-relative path to the bridge', async () => {
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
      requestId: 'n-rel',
      kind: 'newSession',
      payload: {
        agentId: 'fake',
        workspace: { folder: 'file:///workspace/demo', relativePath: 'packages/ui' },
      },
    })

    expect(bridge.newSession).toHaveBeenCalledWith(
      'fake',
      { folder: 'file:///workspace/demo', relativePath: 'packages/ui' },
      null,
      expect.anything(),
    )
    expect(connection.frames.at(-1)).toMatchObject({ ok: true })
  })

  it('rejects an invalid relative path before opening a window', async () => {
    const host = makeHost({
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/recent', name: 'recent' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const bridge = new FakeBridge()
    hub.registerWindow(5, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'n-rel-bad',
      kind: 'newSession',
      payload: {
        agentId: 'fake',
        workspace: { folder: 'file:///workspace/recent', relativePath: '../outside' },
      },
    })

    expect(connection.frames.at(-1)).toMatchObject({ ok: false, error: 'bad_request' })
    expect(host.openWorkspace).not.toHaveBeenCalled()
    expect(bridge.newSession).not.toHaveBeenCalled()
  })

  it('keeps relative paths out of the newSession audit detail', async () => {
    const audit: MobileCommandAudit = { record: vi.fn() }
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

    await hub.handleCommand(
      connection,
      {
        type: 'command',
        requestId: 'n-rel-audit',
        kind: 'newSession',
        payload: {
          agentId: 'fake',
          workspace: { folder: 'file:///workspace/demo', relativePath: 'secret-dir' },
        },
      },
      audit,
    )

    expect(audit.record).toHaveBeenCalledWith('newSession', 'success', 'agent=fake')
    expect(JSON.stringify(vi.mocked(audit.record).mock.calls)).not.toContain('secret-dir')
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

  it('orders open workspaces by last-opened recency', async () => {
    const host = makeHost({
      listOpenWorkspaces: vi.fn(() => [
        { windowId: 1, folder: 'file:///workspace/oldest', name: 'oldest' },
        { windowId: 2, folder: 'file:///workspace/newest', name: 'newest' },
        { windowId: 3, folder: 'file:///workspace/unknown', name: 'unknown' },
        { windowId: 4, folder: 'file:///workspace/middle', name: 'middle' },
      ]),
      listRecentWorkspaces: vi.fn(async () => [
        { folder: 'file:///workspace/newest', name: 'newest' },
        { folder: 'file:///workspace/middle', name: 'middle' },
        { folder: 'file:///workspace/oldest', name: 'oldest' },
      ]),
    })
    const hub = new MobileGatewayHub(NULL_LOGGER, host)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'w-order',
      kind: 'listWorkspaces',
      payload: {},
    })
    const frame = connection.frames.at(-1) as {
      result: readonly MobileWorkspaceCandidate[]
    }
    expect(frame.result.map((workspace) => workspace.name)).toEqual([
      'newest',
      'middle',
      'oldest',
      'unknown',
    ])
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

  it('resolves a session report run id through the owning window bridge', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.sessions = [summary('s1', { durableId: 'd1' })]
    bridge.getAutomationRunId.mockResolvedValue('run-1')
    hub.registerWindow(1, bridge)

    const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }
    await expect(hub.readSessionReportRunId(ref)).resolves.toBe('run-1')
    expect(bridge.getAutomationRunId).toHaveBeenCalledWith('s1', expect.anything())

    await expect(
      hub.readSessionReportRunId({ windowId: 9, localId: 's1' }),
    ).resolves.toBeUndefined()

    bridge.getAutomationRunId.mockResolvedValue(undefined)
    await expect(hub.readSessionReportRunId(ref)).resolves.toBeUndefined()
  })

  it('materializes uploaded draft attachments once per id', async () => {
    const resolveForPrompt = vi.fn(async () => resolvedAttachments)
    const { hub, bridge, connection } = makeHarness({ resolveForPrompt, consume: vi.fn() })
    hub.authenticateConnection(connection, 'dev-1')
    await hub.subscribeSession(connection, ref)
    const frame: DraftUpdateFrame = {
      type: 'draft_update',
      ref,
      clientUpdateId: 'u1',
      draft: {
        text: 'hi',
        images: [{ id: 'att-1', source: 'mobile', mimeType: 'image/png', byteSize: 3 }],
      },
    }

    await hub.handleDraftUpdate(connection, frame)

    expect(resolveForPrompt).toHaveBeenCalledWith('dev-1', ['att-1'])
    expect(bridge.attachDraftAttachments).toHaveBeenCalledWith('s1', resolvedAttachments)

    await hub.handleDraftUpdate(connection, {
      ...frame,
      clientUpdateId: 'u2',
      draft: { ...frame.draft, text: 'hi!' },
    })
    expect(resolveForPrompt).toHaveBeenCalledTimes(1)
  })
})

describe('MobileGatewayHub draft updates', () => {
  function draftFrame(overrides: Partial<DraftUpdateFrame> = {}): DraftUpdateFrame {
    return {
      type: 'draft_update',
      ref: { windowId: 1, localId: 's1', durableId: 'd1' },
      clientUpdateId: 'u1',
      draft: { text: 'hello', images: [] },
      ...overrides,
    }
  }

  async function setup() {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.snapshots.set('s1', snapshot('s1', { summary: summary('s1', { durableId: 'd1' }) }))
    hub.registerWindow(1, bridge)
    const origin = makeConnection()
    const peer = makeConnection()
    for (const connection of [origin, peer]) {
      hub.addConnection(connection)
      hub.subscribeInbox(connection)
      await hub.subscribeSession(connection, {
        windowId: 1,
        localId: 's1',
        durableId: 'd1',
      })
      connection.frames.length = 0
    }
    return { hub, bridge, origin, peer }
  }

  it('applies a phone draft once and fans it out with a caller-only clientUpdateId', async () => {
    const { hub, bridge, origin, peer } = await setup()

    await hub.handleDraftUpdate(origin, draftFrame())

    expect(bridge.applyDraft).toHaveBeenCalledWith('s1', {
      text: 'hello',
      images: [],
    })
    expect(bridge.noteDraftRevision).toHaveBeenCalledWith('s1', 1)
    const originEvents = framesOf(origin, 'session_delta').flatMap((frame) => frame.events)
    const peerEvents = framesOf(peer, 'session_delta').flatMap((frame) => frame.events)
    expect(originEvents).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: 'hello', revision: 1, source: 'mobile' }),
        clientUpdateId: 'u1',
      },
    ])
    expect(peerEvents).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: 'hello', revision: 1, source: 'mobile' }),
      },
    ])
  })

  it('acks a renderer draft with the revision it assigned', async () => {
    const { bridge, origin, peer } = await setup()

    bridge.emit({
      kind: 'draft',
      localId: 's1',
      draft: { text: 'typed on pc', images: [] },
    })
    await tick()

    expect(bridge.ackDraftRevision).toHaveBeenCalledWith('s1', 1)
    expect(framesOf(origin, 'session_delta').flatMap((frame) => frame.events)).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: 'typed on pc', revision: 1, source: 'pc' }),
      },
    ])
    expect(framesOf(peer, 'session_delta').flatMap((frame) => frame.events)).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: 'typed on pc', revision: 1, source: 'pc' }),
      },
    ])

    origin.frames.length = 0
    peer.frames.length = 0
    bridge.emit({ kind: 'draft', localId: 's1', draft: undefined })
    await tick()

    expect(bridge.ackDraftRevision).toHaveBeenLastCalledWith('s1', 2)
    expect(framesOf(peer, 'session_delta').flatMap((frame) => frame.events)).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: '', revision: 2, source: 'pc' }),
      },
    ])
  })

  it('acks a renderer clear even when the registry had no entry', async () => {
    const { bridge, origin } = await setup()

    bridge.emit({ kind: 'draft', localId: 's1', draft: undefined })
    await tick()

    expect(bridge.ackDraftRevision).toHaveBeenCalledWith('s1', 0)
    expect(framesOf(origin, 'session_delta')).toStrictEqual([])
  })

  it('acks an identical update to the caller without re-broadcasting it', async () => {
    const { hub, origin, peer } = await setup()
    await hub.handleDraftUpdate(origin, draftFrame())
    origin.frames.length = 0
    peer.frames.length = 0

    await hub.handleDraftUpdate(origin, draftFrame({ clientUpdateId: 'u2' }))

    const originEvents = framesOf(origin, 'session_delta').flatMap((frame) => frame.events)
    expect(originEvents).toStrictEqual([
      {
        type: 'draft_update',
        draft: expect.objectContaining({ text: 'hello', revision: 1 }),
        clientUpdateId: 'u2',
      },
    ])
    expect(framesOf(peer, 'session_delta')).toStrictEqual([])
  })

  it('ignores a draft for a session the connection has not subscribed to', async () => {
    const { hub, bridge, origin } = await setup()

    await hub.handleDraftUpdate(
      origin,
      draftFrame({ ref: { windowId: 1, localId: 'other', durableId: 'd9' } }),
    )

    expect(bridge.applyDraft).not.toHaveBeenCalled()
    expect(framesOf(origin, 'session_delta')).toStrictEqual([])
  })

  it('seeds a new subscriber snapshot with the registry draft', async () => {
    const { hub, origin } = await setup()
    await hub.handleDraftUpdate(origin, draftFrame())

    const late = makeConnection()
    hub.addConnection(late)
    await hub.subscribeSession(late, { windowId: 1, localId: 's1', durableId: 'd1' })

    const snapshots = framesOf(late, 'session_snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.session.draft).toMatchObject({
      text: 'hello',
      revision: 1,
      source: 'mobile',
    })
  })

  it('removes an empty phone draft so a later snapshot cannot resurrect it', async () => {
    const { hub, origin } = await setup()
    await hub.handleDraftUpdate(origin, draftFrame())
    await hub.handleDraftUpdate(
      origin,
      draftFrame({
        clientUpdateId: 'u-clear',
        draft: { text: '', images: [] },
      }),
    )

    const late = makeConnection()
    hub.addConnection(late)
    await hub.subscribeSession(late, { windowId: 1, localId: 's1', durableId: 'd1' })

    expect(framesOf(late, 'session_snapshot')[0]?.session.draft).toBeUndefined()
  })

  it('resolves a stale localId through the durable id', async () => {
    const { hub, bridge, origin } = await setup()

    await hub.handleDraftUpdate(
      origin,
      draftFrame({ ref: { windowId: 1, localId: 'stale', durableId: 'd1' } }),
    )

    expect(bridge.applyDraft).toHaveBeenCalledWith('s1', {
      text: 'hello',
      images: [],
    })
  })

  it('serves bytes only for an image the draft actually references', async () => {
    const { hub, bridge, origin } = await setup()
    bridge.getDraftImage.mockResolvedValue({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
    await hub.handleDraftUpdate(origin, draftFrame())

    await expect(
      hub.readDraftImage({ windowId: 1, localId: 's1', durableId: 'd1' }, 'img-1'),
    ).resolves.toBeUndefined()

    await hub.handleDraftUpdate(
      origin,
      draftFrame({
        clientUpdateId: 'u2',
        draft: {
          text: 'hello',
          images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3 }],
        },
      }),
    )
    const image = await hub.readDraftImage({ windowId: 1, localId: 's1', durableId: 'd1' }, 'img-1')
    expect(image).toMatchObject({ mimeType: 'image/png' })
    expect(bridge.getDraftImage).toHaveBeenCalledWith('s1', 'img-1', expect.anything())
  })

  it('resolves PC draft images on send and clears the shared draft', async () => {
    const { hub, bridge, origin } = await setup()
    bridge.resolveDraftAttachments.mockResolvedValue({
      ok: true,
      value: [
        {
          kind: 'image',
          id: 'img-1',
          name: 'shot.png',
          mimeType: 'image/png',
          byteSize: 3,
          dataBase64: 'AQID',
        },
        {
          kind: 'file',
          id: 'file-1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          byteSize: 7,
          uri: 'file:///tmp/notes.txt',
        },
      ],
    })
    await hub.handleDraftUpdate(
      origin,
      draftFrame({
        draft: {
          text: 'hello',
          images: [{ id: 'img-1', source: 'pc', mimeType: 'image/png', byteSize: 3 }],
        },
      }),
    )
    origin.frames.length = 0

    await hub.handleCommand(origin, {
      type: 'command',
      requestId: 'send-1',
      kind: 'sendPrompt',
      payload: {
        ref: { windowId: 1, localId: 's1', durableId: 'd1' },
        text: 'hello',
        draftImageIds: ['img-1'],
        draftFileIds: ['file-1'],
      },
    })

    expect(bridge.resolveDraftAttachments).toHaveBeenCalledWith('s1', ['img-1'], ['file-1'])
    expect(bridge.sendPrompt).toHaveBeenCalledWith('s1', 'hello', [
      expect.objectContaining({ kind: 'image', id: 'img-1' }),
      expect.objectContaining({ kind: 'file', id: 'file-1' }),
    ])
    expect(bridge.clearDraft).toHaveBeenCalledWith('s1')
    const draftEvents = framesOf(origin, 'session_delta')
      .flatMap((frame) => frame.events)
      .filter((event) => event.type === 'draft_update')
    expect(draftEvents.at(-1)?.draft.text).toBe('')
  })
})

describe('MobileGatewayHub delivery commands', () => {
  const ref: MobileSessionRef = { windowId: 1, localId: 's1', durableId: 'd1' }
  const expectation = {
    mainHead: 'm1',
    mainBranch: 'main',
    targetBranch: 'main',
    remote: 'origin',
    remoteBranch: 'main',
    upstreamRef: 'origin/main',
    upstreamHead: 'u1',
    sourceHead: 's1',
    baseSha: 'b1',
    commits: ['c1'],
  }

  it('projects delivery summaries into inbox snapshots', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    const delivery = {
      deliveryId: 'del-1',
      phase: 'awaiting_push' as const,
      commitCount: 2,
      dirtySource: false,
      mainBranch: 'main',
      updatedAt: 10,
      canConfirmPush: true,
      canRetry: false,
      canUndo: true,
      sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
    }
    bridge.sessions = [summary('s1', { durableId: 'd1', delivery, deliveryAvailable: true })]
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    hub.subscribeInbox(connection)
    await tick()

    const frame = framesOf(connection, 'inbox_snapshot')[0]
    expect(frame?.sessions[0]).toMatchObject({ delivery, deliveryAvailable: true })
    expect(frame?.sessions[0]?.delivery?.phase).toBe('awaiting_push')
  })

  it('routes previewDelivery with the durable id', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.previewDelivery.mockResolvedValueOnce({
      ok: false,
      code: 'delivery_unsupported',
      message: 'no repository',
    })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'preview',
      kind: 'previewDelivery',
      payload: { ref },
    })

    expect(bridge.previewDelivery).toHaveBeenCalledWith('s1', 'd1')
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      requestId: 'preview',
      ok: false,
      error: 'delivery_unsupported',
    })
  })

  it('routes previewPushBranch with the durable id', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.previewPushBranch.mockResolvedValueOnce({
      ok: false,
      code: 'push_unsupported',
      message: 'no repository',
    })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'push-preview',
      kind: 'previewPushBranch',
      payload: { ref },
    })

    expect(bridge.previewPushBranch).toHaveBeenCalledWith('s1', 'd1')
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      requestId: 'push-preview',
      ok: false,
      error: 'push_unsupported',
    })
  })

  it('routes pushBranch with the pinned expectation', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    bridge.pushBranch.mockResolvedValueOnce({
      ok: false,
      code: 'push_conflict',
      message: 'remote moved',
    })
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)
    const expectation = {
      branch: 'feature',
      head: 's1',
      remote: 'origin',
      remoteBranch: 'feature',
      remoteHead: 'r1',
    }

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'push',
      kind: 'pushBranch',
      payload: { ref, expectation },
    })

    expect(bridge.pushBranch).toHaveBeenCalledWith('s1', expectation, 'd1')
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      requestId: 'push',
      ok: false,
      error: 'push_conflict',
    })
  })

  it('rejects a start when another window is delivering the same worktree', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const target = new FakeBridge()
    target.getDeliveryContext.mockResolvedValueOnce({ sourceCwd: 'D:/repo/feature' })
    const other = new FakeBridge()
    other.listActiveDeliveries.mockResolvedValueOnce([
      { sourceCwd: 'D:/repo/feature', mainWorktree: 'D:/repo/main', phase: 'cherry_picking' },
    ])
    hub.registerWindow(1, target)
    hub.registerWindow(2, other)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'start',
      kind: 'startDelivery',
      payload: { ref, expectation },
    })

    expect(target.startDelivery).not.toHaveBeenCalled()
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      ok: false,
      error: 'delivery_busy',
    })
  })

  it('starts a delivery when the other window works on a different worktree', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const target = new FakeBridge()
    target.getDeliveryContext.mockResolvedValueOnce({ sourceCwd: 'D:/repo/feature' })
    target.startDelivery.mockResolvedValueOnce({ ok: true, value: { deliveryId: 'del-1' } })
    const other = new FakeBridge()
    other.listActiveDeliveries.mockResolvedValueOnce([
      { sourceCwd: 'D:/repo/other', mainWorktree: 'D:/repo/main', phase: 'preflighting' },
    ])
    hub.registerWindow(1, target)
    hub.registerWindow(2, other)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'start',
      kind: 'startDelivery',
      payload: { ref, expectation },
    })

    expect(target.startDelivery).toHaveBeenCalledWith('s1', expectation, 'd1')
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      ok: true,
      result: { deliveryId: 'del-1' },
    })
  })

  it('routes confirm, retry, undo, get and open-main-worktree', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const bridge = new FakeBridge()
    hub.registerWindow(1, bridge)
    const connection = makeConnection()
    hub.addConnection(connection)

    const calls: Array<[string, string]> = [
      ['getDelivery', 'getDelivery'],
      ['confirmDeliveryPush', 'confirmDeliveryPush'],
      ['retryDelivery', 'retryDelivery'],
      ['undoDelivery', 'undoDelivery'],
      ['openDeliveryMainWorktree', 'openDeliveryMainWorktree'],
    ]
    for (const [kind] of calls) {
      await hub.handleCommand(connection, {
        type: 'command',
        requestId: kind,
        kind,
        payload: { ref, deliveryId: 'del-1' },
      })
    }

    expect(bridge.getDelivery).toHaveBeenCalledWith('s1', 'del-1')
    expect(bridge.confirmDeliveryPush).toHaveBeenCalledWith('s1', 'del-1')
    expect(bridge.retryDelivery).toHaveBeenCalledWith('s1', 'del-1')
    expect(bridge.undoDelivery).toHaveBeenCalledWith('s1', 'del-1')
    expect(bridge.openDeliveryMainWorktree).toHaveBeenCalledWith('s1', 'del-1')
  })

  it('rejects prompts while another window delivers the same worktree', async () => {
    const hub = new MobileGatewayHub(NULL_LOGGER)
    const target = new FakeBridge()
    target.getDeliveryContext.mockResolvedValueOnce({ sourceCwd: 'D:/repo/feature' })
    const other = new FakeBridge()
    other.listActiveDeliveries.mockResolvedValueOnce([
      { sourceCwd: 'D:/repo/feature', mainWorktree: 'D:/repo/main', phase: 'pushing' },
    ])
    hub.registerWindow(1, target)
    hub.registerWindow(2, other)
    const connection = makeConnection()
    hub.addConnection(connection)

    await hub.handleCommand(connection, {
      type: 'command',
      requestId: 'prompt',
      kind: 'sendPrompt',
      payload: { ref, text: 'continue' },
    })

    expect(target.sendPrompt).not.toHaveBeenCalled()
    expect(framesOf(connection, 'command_result')[0]).toMatchObject({
      ok: false,
      error: 'delivery_busy',
    })
  })

  describe('hasSessionSubscribers', () => {
    function setup() {
      const hub = new MobileGatewayHub(NULL_LOGGER)
      const bridge = new FakeBridge()
      bridge.sessions = [summary('s1')]
      bridge.snapshots.set('s1', snapshot('s1'))
      hub.registerWindow(1, bridge)
      const connection = makeConnection()
      hub.addConnection(connection)
      return { hub, bridge, connection }
    }

    it('is true while a phone subscribes to a session in that window', async () => {
      const { hub, connection } = setup()
      await hub.subscribeSession(connection, { windowId: 1, localId: 's1' })
      expect(hub.hasSessionSubscribers(1)).toBe(true)
      expect(hub.hasSessionSubscribers(2)).toBe(false)

      hub.unsubscribeSession(connection, { windowId: 1, localId: 's1' })
      expect(hub.hasSessionSubscribers(1)).toBe(false)
    })

    it('ignores inbox-only and attention-only connections', async () => {
      const { hub, connection } = setup()
      hub.subscribeInbox(connection)
      hub.setAttentionNeeded(true)
      await tick()
      expect(hub.hasSessionSubscribers(1)).toBe(false)
    })

    it('is false after the connection or the window goes away', async () => {
      const first = setup()
      await first.hub.subscribeSession(first.connection, { windowId: 1, localId: 's1' })
      first.hub.removeConnection(first.connection)
      expect(first.hub.hasSessionSubscribers(1)).toBe(false)

      const second = setup()
      await second.hub.subscribeSession(second.connection, { windowId: 1, localId: 's1' })
      second.hub.unregisterWindow(1)
      expect(second.hub.hasSessionSubscribers(1)).toBe(false)
    })
  })
})
