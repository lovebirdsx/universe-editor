import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  Emitter,
  Event,
  observableValue,
  URI,
  type IEditorGroupsService,
  type ILogger,
  type ILoggerService,
  type ISettableObservable,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AcpMessage,
  AcpPendingElicitation,
  AcpPermissionSettledEvent,
  AcpPendingPermission,
  AcpPlanEntry,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../../acp/session/acpSession.js'
import type { IAcpSessionService } from '../../acp/session/acpSessionService.js'
import type {
  AcpSessionHistoryEntry,
  IAcpSessionHistoryService,
} from '../../acp/session/acpSessionHistory.js'
import type { IAcpAgentRegistry } from '../../acp/acpAgentRegistry.js'
import {
  MOBILE_BRIDGE_LARGE_THROTTLE_MS,
  MOBILE_BRIDGE_THROTTLE_MS,
  MobileBridgeService,
} from '../MobileBridgeService.js'
import type { MobileBridgeEvent } from '../../../../shared/ipc/mobileGatewayService.js'

const NULL_LOGGER: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogger

interface FakeSessionHarness {
  session: IAcpSession
  timeline: ISettableObservable<readonly TimelineItem[]>
  toolCalls: ISettableObservable<readonly AcpToolCall[]>
  plan: ISettableObservable<readonly AcpPlanEntry[]>
  configOptions: ISettableObservable<readonly SessionConfigOption[]>
  usage: ISettableObservable<AcpUsage | undefined>
  pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  settlePermission: (event: AcpPermissionSettledEvent) => void
  status: ISettableObservable<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>
  isDormant: ISettableObservable<boolean>
  backgroundTaskCount: ISettableObservable<number>
  isReplayingHistory: ISettableObservable<boolean>
  sessionIdOnAgent: ISettableObservable<string | undefined>
}

function makeSession(
  id: string,
  options: { durableId?: string; title?: string; readOnly?: boolean } = {},
): FakeSessionHarness {
  const timeline = observableValue<readonly TimelineItem[]>('test.timeline', [])
  const toolCalls = observableValue<readonly AcpToolCall[]>('test.toolCalls', [])
  const plan = observableValue<readonly AcpPlanEntry[]>('test.plan', [])
  const configOptions = observableValue<readonly SessionConfigOption[]>('test.config', [])
  const usage = observableValue<AcpUsage | undefined>('test.usage', undefined)
  const pendingPermission = observableValue<AcpPendingPermission | undefined>(
    'test.permission',
    undefined,
  )
  const pendingElicitation = observableValue<AcpPendingElicitation | undefined>(
    'test.elicitation',
    undefined,
  )
  const status = observableValue<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>(
    'test.status',
    'idle',
  )
  const isDormant = observableValue<boolean>('test.dormant', false)
  const backgroundTaskCount = observableValue<number>('test.bg', 0)
  const isReplayingHistory = observableValue<boolean>('test.replay', false)
  const sessionIdOnAgent = observableValue<string | undefined>('test.durable', options.durableId)
  const settleEmitter = new Emitter<AcpPermissionSettledEvent>()
  const session = {
    id,
    agentId: 'fake',
    title: options.title ?? `Session ${id}`,
    cwd: '/workspace/demo',
    authority: undefined,
    readOnly: options.readOnly ?? false,
    timeline,
    toolCalls,
    plan,
    configOptions,
    usage,
    pendingPermission,
    pendingElicitation,
    settlePermission: (event: AcpPermissionSettledEvent) => settleEmitter.fire(event),
    status,
    isDormant,
    backgroundTaskCount,
    isReplayingHistory,
    sessionIdOnAgent,
    onDidSettlePermission: settleEmitter.event,
    onDidSettleElicitation: Event.None,
    sendPrompt: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    renameTitle: vi.fn(),
  } as unknown as IAcpSession
  return {
    session,
    timeline,
    toolCalls,
    plan,
    configOptions,
    usage,
    pendingPermission,
    pendingElicitation,
    settlePermission: (event: AcpPermissionSettledEvent) => settleEmitter.fire(event),
    status,
    isDormant,
    backgroundTaskCount,
    isReplayingHistory,
    sessionIdOnAgent,
  }
}

function message(id: string, text: string, streaming = false): AcpMessage {
  return { id, role: 'agent', text, blocks: [{ type: 'text', text }], streaming }
}

function messageItem(id: string, text: string, streaming = false): TimelineItem {
  return { kind: 'message', id, message: message(id, text, streaming) }
}

function toolCall(overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id: 'tool-1',
    title: 'Edit file',
    kind: 'edit',
    status: 'completed',
    text: 'applied',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function makeHarness(): {
  service: MobileBridgeService
  sessions: ISettableObservable<readonly IAcpSession[]>
  history: ISettableObservable<readonly AcpSessionHistoryEntry[]>
  events: MobileBridgeEvent[]
  created: ReturnType<typeof vi.fn>
  sessionService: IAcpSessionService
  workspace: { current: { folder: URI; name: string } | null }
  add(session: FakeSessionHarness): void
  remove(id: string): void
} {
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const history = observableValue<readonly AcpSessionHistoryEntry[]>('test.history', [])
  const live = new Map<string, IAcpSession>()
  const created = vi.fn()
  const sessionService = {
    sessions,
    getById: (id: string) => live.get(id),
    createSession: vi.fn(async () => created()),
    closeSession: vi.fn(async () => {}),
    deleteOnAgent: vi.fn(async () => {}),
  } as unknown as IAcpSessionService
  const historyService = {
    entries: history,
    get: () => undefined,
    list: () => [],
    removeDeleted: vi.fn(),
  } as unknown as IAcpSessionHistoryService
  const registry = {
    get: (id: string) => {
      if (id !== 'fake' && id !== 'other') throw new Error('unknown agent')
      return { id, name: id === 'fake' ? 'Fake Agent' : 'Other Agent' }
    },
    list: () => [
      { id: 'fake', name: 'Fake Agent' },
      { id: 'other', name: 'Other Agent' },
    ],
    defaultAgentId: () => 'fake',
  } as unknown as IAcpAgentRegistry
  const loggerService = { createLogger: () => NULL_LOGGER } as unknown as ILoggerService
  const workspace = { current: null } as unknown as IWorkspaceService & {
    current: { folder: URI; name: string } | null
  }
  const editorGroups = { groups: [] } as unknown as IEditorGroupsService
  const service = new MobileBridgeService(
    sessionService,
    historyService,
    registry,
    workspace,
    editorGroups,
    loggerService,
  )
  const events: MobileBridgeEvent[] = []
  service.onDidChange((event) => events.push(event))
  return {
    service,
    sessions,
    history,
    events,
    created,
    sessionService,
    workspace: workspace as unknown as { current: { folder: URI; name: string } | null },
    add(session) {
      live.set(session.session.id, session.session)
      sessions.set([...sessions.get(), session.session], undefined)
    },
    remove(id) {
      live.delete(id)
      const next = sessions.get().filter((session) => session.id !== id)
      if (next.length === 0) sessions.set([], undefined)
      else sessions.set([...next], undefined)
    },
  }
}

async function flush(ms = MOBILE_BRIDGE_THROTTLE_MS + 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('MobileBridgeService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does no work before startStreaming', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.add(first)

    first.timeline.set([messageItem('m1', 'before')], undefined)
    first.status.set('running', undefined)
    await flush(300)

    expect(harness.events).toStrictEqual([])
  })

  it('builds a read-only snapshot with history title and projected timeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.history.set(
      [{ id: 'd1', title: 'History title' } as unknown as AcpSessionHistoryEntry],
      undefined,
    )
    harness.add(first)
    first.status.set('running', undefined)
    first.sessionIdOnAgent.set('d1', undefined)
    first.timeline.set(
      [
        messageItem('m1', 'hello'),
        {
          kind: 'toolCall',
          id: 'tool-1',
          call: toolCall({
            text: 'diff body',
            diffs: [{ path: '/workspace/a.ts', oldText: 'a\nb', newText: 'a\nc' }],
            locations: [{ path: '/workspace/a.ts', line: 2 }],
          }),
        },
      ],
      undefined,
    )
    first.plan.set([{ content: 'Step', status: 'in_progress' }], undefined)
    first.configOptions.set(
      [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'm1',
          options: [{ value: 'm1', name: 'Model One' }],
        } as unknown as SessionConfigOption,
      ],
      undefined,
    )
    first.usage.set({ used: 10, size: 100, cost: { amount: 0.1, currency: 'USD' } }, undefined)

    const snapshot = await harness.service.getSnapshot('s1')

    expect(snapshot?.summary).toMatchObject({
      localId: 's1',
      durableId: 'd1',
      agentId: 'fake',
      agentName: 'Fake Agent',
      title: 'History title',
      status: 'running',
      displayStatus: 'running',
      bucket: 'in_progress',
      cwd: '/workspace/demo',
      readOnly: false,
      hasPendingPermission: false,
      hasPendingElicitation: false,
      backgroundTaskCount: 0,
    })
    expect(snapshot?.timeline[0]).toStrictEqual({
      kind: 'message',
      id: 'm1',
      role: 'agent',
      text: 'hello',
      streaming: false,
    })
    expect(snapshot?.timeline[1]).toMatchObject({
      kind: 'toolCall',
      id: 'tool-1',
      toolKind: 'edit',
      hasDetail: true,
      preview: 'diff body',
      diffs: [{ path: '/workspace/a.ts', added: 1, removed: 1 }],
      locations: [{ path: '/workspace/a.ts', line: 2 }],
    })
    expect(snapshot?.plan).toStrictEqual([{ content: 'Step', status: 'in_progress' }])
    expect(snapshot?.configOptions).toStrictEqual([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'Model One',
        allowedOnMobile: true,
        options: [{ value: 'm1', label: 'Model One', allowedOnMobile: true }],
      },
    ])
    expect(snapshot?.usage).toStrictEqual({
      used: 10,
      size: 100,
      cost: { amount: 0.1, currency: 'USD' },
    })
  })

  it('streams a new timeline item and suffix-only message updates', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    await flush()

    first.timeline.set([messageItem('m1', 'hello', true)], undefined)
    await flush()
    const added = harness.events.find(
      (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
        event.kind === 'session_delta' &&
        event.events.some((e) => e.type === 'timeline_item_added'),
    )
    expect(added?.events).toContainEqual({
      type: 'timeline_item_added',
      item: { kind: 'message', id: 'm1', role: 'agent', text: 'hello', streaming: true },
    })

    harness.events.length = 0
    first.timeline.set([messageItem('m1', 'hello world', true)], undefined)
    await flush()
    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
      .find((event) => event.type === 'message_upsert')
    expect(upsert).toStrictEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: true,
      textAppend: ' world',
    })
  })

  it('replaces text when the new text is not an extension of the old one', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'original text')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', 'rewound')], undefined)
    await flush()
    const events = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(events).toContainEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: false,
      textReplace: 'rewound',
    })
  })

  it('emits tool-call upserts with preview and diff statistics', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.toolCalls.set([toolCall()], undefined)
    first.timeline.set([{ kind: 'toolCall', id: 'tool-1', call: toolCall() }], undefined)
    await flush()
    harness.events.length = 0

    first.toolCalls.set(
      [
        toolCall({
          status: 'in_progress',
          text: 'body',
          diffs: [{ path: '/workspace/a.ts', oldText: 'one\ntwo', newText: 'one\nthree' }],
        }),
      ],
      undefined,
    )
    first.timeline.set(
      [
        {
          kind: 'toolCall',
          id: 'tool-1',
          call: toolCall({
            status: 'in_progress',
            text: 'body',
            diffs: [{ path: '/workspace/a.ts', oldText: 'one\ntwo', newText: 'one\nthree' }],
          }),
        },
      ],
      undefined,
    )
    await flush()

    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
      .find((event) => event.type === 'tool_call_upsert')
    expect(upsert).toMatchObject({
      type: 'tool_call_upsert',
      item: {
        kind: 'toolCall',
        id: 'tool-1',
        status: 'in_progress',
        preview: 'body',
        diffs: [{ path: '/workspace/a.ts', added: 1, removed: 1 }],
      },
    })
  })

  it('emits permission upserts and clears them', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    await flush()
    harness.events.length = 0

    const permission: AcpPendingPermission = {
      requestId: 'req-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: [{ optionId: 'allow', name: 'Allow' }],
      resolve: () => {},
      cancel: () => {},
      resolveWithSource: () => {},
      cancelWithSource: () => {},
    }
    first.pendingPermission.set(permission, undefined)
    await flush()
    const upsert = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(upsert[0]).toMatchObject({ type: 'permission_upsert' })
    expect(upsert.at(-1)).toMatchObject({
      type: 'summary_changed',
      summary: { hasPendingPermission: true, displayStatus: 'ask', bucket: 'input_needed' },
    })

    harness.events.length = 0
    first.pendingPermission.set(undefined, undefined)
    await flush()
    const cleared = harness.events
      .filter(
        (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
          event.kind === 'session_delta',
      )
      .flatMap((event) => event.events)
    expect(cleared[0]).toStrictEqual({
      type: 'permission_cleared',
      requestId: 'req-1',
      reason: 'cancelled',
      source: 'pc',
    })
  })

  it('coalesces rapid updates into one delta batch', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'a')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', 'ab')], undefined)
    await vi.advanceTimersByTimeAsync(10)
    first.timeline.set([messageItem('m1', 'abc')], undefined)
    await vi.advanceTimersByTimeAsync(10)
    first.timeline.set([messageItem('m1', 'abcd')], undefined)
    await flush()

    const deltas = harness.events.filter(
      (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
        event.kind === 'session_delta',
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.events).toContainEqual({
      type: 'message_upsert',
      id: 'm1',
      role: 'agent',
      streaming: false,
      textAppend: 'bcd',
    })
  })

  it('slows the throttle window for a single large message delta', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startStreaming()
    first.timeline.set([messageItem('m1', 'a')], undefined)
    await flush()
    harness.events.length = 0

    first.timeline.set([messageItem('m1', `a${'x'.repeat(70 * 1024)}`)], undefined)
    await vi.advanceTimersByTimeAsync(MOBILE_BRIDGE_THROTTLE_MS + 10)
    expect(harness.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(MOBILE_BRIDGE_LARGE_THROTTLE_MS)
    expect(harness.events.length).toBeGreaterThan(0)
  })

  it('publishes inbox removals when a session disappears', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { durableId: 'd1' })
    harness.add(first)
    await harness.service.startStreaming()
    await flush()
    harness.events.length = 0

    harness.remove('s1')
    await vi.advanceTimersByTimeAsync(5)

    expect(harness.events).toContainEqual({
      kind: 'inbox',
      upserts: [],
      removes: [{ localId: 's1', durableId: 'd1' }],
    })
  })

  it('returns full tool-call detail and undefined for unknown ids', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const call = toolCall({
      text: 'full body',
      diffs: [{ path: '/workspace/a.ts', oldText: 'o', newText: 'n' }],
      locations: [{ path: '/workspace/a.ts', line: 1 }],
    })
    first.toolCalls.set([call], undefined)

    await expect(harness.service.getToolCallDetail('s1', 'tool-1')).resolves.toStrictEqual({
      id: 'tool-1',
      title: 'Edit file',
      kind: 'edit',
      status: 'completed',
      text: 'full body',
      diffs: [{ path: '/workspace/a.ts', oldText: 'o', newText: 'n' }],
      locations: [{ path: '/workspace/a.ts', line: 1 }],
    })
    await expect(harness.service.getToolCallDetail('s1', 'missing')).resolves.toBeUndefined()
    await expect(harness.service.getToolCallDetail('missing', 'tool-1')).resolves.toBeUndefined()
  })
})

describe('MobileBridgeService commands', () => {
  function makePermission(
    requestId: string,
    options: AcpPendingPermission['options'],
    extra: Partial<AcpPendingPermission> = {},
  ): AcpPendingPermission {
    return {
      requestId,
      toolCallId: 'tool-1',
      title: 'Run command',
      options,
      resolve: vi.fn(),
      cancel: vi.fn(),
      resolveWithSource: vi.fn(),
      cancelWithSource: vi.fn(),
      ...extra,
    }
  }

  function makeElicitation(requestId: string): AcpPendingElicitation {
    return {
      requestId,
      request: {
        message: 'Name?',
        requestedSchema: { type: 'object', properties: {} },
      } as unknown as AcpPendingElicitation['request'],
      resolve: vi.fn(),
      cancel: vi.fn(),
      resolveWithSource: vi.fn(),
      cancelWithSource: vi.fn(),
    }
  }

  function callSpy<T extends (...args: never[]) => unknown>(session: IAcpSession, name: string): T {
    return (session as unknown as Record<string, T>)[name]!
  }

  it('forwards prompt, cancel, rename and config commands to the session', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    first.configOptions.set(
      [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
      ] as unknown as SessionConfigOption[],
      undefined,
    )

    await expect(harness.service.sendPrompt('s1', 'hello')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy<(...a: unknown[]) => unknown>(first.session, 'sendPrompt')).toHaveBeenCalledWith(
      'hello',
    )

    await expect(harness.service.cancelTurn('s1')).resolves.toEqual({ ok: true, value: undefined })
    expect(callSpy(first.session, 'cancelTurn')).toHaveBeenCalled()

    await expect(harness.service.renameSession('s1', 'New title')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy(first.session, 'renameTitle')).toHaveBeenCalledWith('New title')

    await expect(harness.service.setConfigOption('s1', 'mode', 'code')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    await expect(harness.service.setConfigOption('s1', 'fast', true)).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenNthCalledWith(1, 'mode', 'code')
    expect(callSpy(first.session, 'setConfigOption')).toHaveBeenNthCalledWith(2, 'fast', true)
  })

  it('rejects unknown sessions, read-only sessions and unknown ids', async () => {
    const harness = makeHarness()
    const readOnly = makeSession('ro', { readOnly: true })
    harness.add(readOnly)

    await expect(harness.service.sendPrompt('missing', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
    await expect(harness.service.sendPrompt('ro', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    await expect(harness.service.resolvePermission('ro', 'r1', 'allow')).resolves.toMatchObject({
      ok: false,
      code: 'session_read_only',
    })
    await expect(harness.service.renameSession('missing', 'x')).resolves.toMatchObject({
      ok: false,
      code: 'session_not_found',
    })
  })

  it('settles a permission once with the mobile source and rejects stale or high-risk options', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makePermission('req-1', [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    ])
    first.pendingPermission.set(pending, undefined)

    await expect(
      harness.service.resolvePermission('s1', 'stale', 'allow-once'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(
      harness.service.resolvePermission('s1', 'req-1', 'missing'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(
      harness.service.resolvePermission('s1', 'req-1', 'allow-always'),
    ).resolves.toMatchObject({ ok: false, code: 'forbidden_operation' })
    expect(pending.resolveWithSource).not.toHaveBeenCalled()

    await expect(
      harness.service.resolvePermission('s1', 'req-1', 'allow-once', 'looks good'),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(pending.resolveWithSource).toHaveBeenCalledWith('allow-once', 'mobile', 'looks good')
  })

  it('cancels a permission with the mobile source and rejects stale requests', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makePermission('req-1', [{ optionId: 'allow-once', name: 'Allow' }])
    first.pendingPermission.set(pending, undefined)

    await expect(harness.service.cancelPermission('s1', 'other')).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(harness.service.cancelPermission('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(pending.cancelWithSource).toHaveBeenCalledWith('mobile', 'cancelled')
  })

  it('resolves an elicitation with the mobile source and rejects stale requests', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pending = makeElicitation('e1')
    first.pendingElicitation.set(pending, undefined)

    await expect(
      harness.service.resolveElicitation('s1', 'stale', 'decline'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(
      harness.service.resolveElicitation('s1', 'e1', 'accept', { name: 'Ada' }),
    ).resolves.toEqual({ ok: true, value: undefined })
    expect(pending.resolveWithSource).toHaveBeenCalledWith(
      { action: 'accept', content: { name: 'Ada' } },
      'mobile',
    )
    await expect(harness.service.resolveElicitation('s1', 'nope', 'cancel')).resolves.toMatchObject(
      {
        ok: false,
        code: 'stale_request',
      },
    )
  })

  it('rejects high-risk config values before asking the session', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    first.configOptions.set(
      [
        {
          id: 'approval',
          name: 'Approval',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'bypassPermissions', name: 'Bypass' },
          ],
        },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
      ] as unknown as SessionConfigOption[],
      undefined,
    )

    await expect(
      harness.service.setConfigOption('s1', 'approval', 'bypassPermissions'),
    ).resolves.toMatchObject({ ok: false, code: 'forbidden_operation' })
    await expect(
      harness.service.setConfigOption('s1', 'approval', 'missing'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(harness.service.setConfigOption('s1', 'missing', 'ask')).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    await expect(harness.service.setConfigOption('s1', 'fast', 'true')).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
    expect(callSpy(first.session, 'setConfigOption')).not.toHaveBeenCalled()
  })

  it('forwards auto-resolve pause and resume, rejecting stale countdowns', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    const pause = vi.fn()
    const resume = vi.fn()
    const pending = makePermission('req-1', [{ optionId: 'execute', name: 'Execute' }], {
      autoResolve: {
        optionId: 'execute',
        delayMs: 3000,
        state: observableValue('test.auto', {
          paused: false,
          remainingMs: 3000,
          cancelled: false,
        }),
        pause,
        resume,
        cancel: vi.fn(),
      },
    })
    first.pendingPermission.set(pending, undefined)

    await expect(harness.service.pauseAutoResolve('s1', 'stale')).resolves.toMatchObject({
      ok: false,
      code: 'stale_request',
    })
    await expect(harness.service.pauseAutoResolve('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    await expect(harness.service.resumeAutoResolve('s1', 'req-1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(pause).toHaveBeenCalled()
    expect(resume).toHaveBeenCalled()
  })

  it('creates a session for a known agent and forwards the initial prompt', async () => {
    const harness = makeHarness()
    const created = makeSession('new-1', { durableId: 'd-new' })
    harness.created.mockReturnValue(created.session)

    await expect(
      harness.service.newSession('fake', { folder: 'file:///workspace/demo' }, 'start here'),
    ).resolves.toEqual({ ok: true, value: { localId: 'new-1', durableId: 'd-new' } })
    expect(harness.sessionService.createSession).toHaveBeenCalledWith('fake', {
      cwd: '/workspace/demo',
    })
    expect(callSpy(created.session, 'sendPrompt')).toHaveBeenCalledWith('start here')

    await expect(
      harness.service.newSession('unknown', { folder: 'file:///workspace/demo' }),
    ).resolves.toMatchObject({ ok: false, code: 'bad_request' })
    await expect(
      harness.service.newSession('fake', { folder: 'not a uri' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    })
  })

  it('deletes a session through the shared removal pipeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)

    await expect(harness.service.deleteSession('s1')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
    expect(harness.sessionService.closeSession).toHaveBeenCalledWith('s1')
  })

  it('lists this window workspace and the visible agents', async () => {
    const harness = makeHarness()
    harness.workspace.current = {
      folder: URI.parse('file:///workspace/demo'),
      name: 'demo',
    }

    await expect(harness.service.listWorkspaces()).resolves.toStrictEqual([
      { folder: 'file:///workspace/demo', name: 'demo', isOpen: true },
    ])
    await expect(harness.service.listAgents()).resolves.toStrictEqual([
      { id: 'fake', name: 'Fake Agent', isDefault: true },
      { id: 'other', name: 'Other Agent', isDefault: false },
    ])
  })
})

describe('MobileBridgeService permission supersede', () => {
  it('clears the replaced request before broadcasting the new one', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const first = makeSession('s1')
      harness.add(first)
      await harness.service.startStreaming()
      first.pendingPermission.set(
        {
          requestId: 'req-1',
          toolCallId: 'tool-1',
          title: 'First',
          options: [{ optionId: 'allow-once', name: 'Allow' }],
          resolve: () => {},
          cancel: () => {},
          resolveWithSource: () => {},
          cancelWithSource: () => {},
        },
        undefined,
      )
      await flush()
      harness.events.length = 0

      // Mirrors presentPermission(): clear the old card, settle it as
      // superseded, then present the replacement.
      first.pendingPermission.set(undefined, undefined)
      first.settlePermission({
        requestId: 'req-1',
        outcome: 'cancelled',
        source: 'pc',
        reason: 'superseded',
      })
      first.pendingPermission.set(
        {
          requestId: 'req-2',
          toolCallId: 'tool-2',
          title: 'Second',
          options: [{ optionId: 'allow-once', name: 'Allow' }],
          resolve: () => {},
          cancel: () => {},
          resolveWithSource: () => {},
          cancelWithSource: () => {},
        },
        undefined,
      )
      await flush()

      const events = harness.events
        .filter(
          (event): event is Extract<MobileBridgeEvent, { kind: 'session_delta' }> =>
            event.kind === 'session_delta',
        )
        .flatMap((event) => event.events)
        .filter(
          (event) => event.type === 'permission_cleared' || event.type === 'permission_upsert',
        )
      expect(events).toStrictEqual([
        {
          type: 'permission_cleared',
          requestId: 'req-1',
          reason: 'superseded',
          source: 'pc',
        },
        expect.objectContaining({
          type: 'permission_upsert',
          permission: expect.objectContaining({ requestId: 'req-2' }),
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MobileBridgeService attention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits attention edges without starting the streaming pipeline', async () => {
    const harness = makeHarness()
    const first = makeSession('s1', { title: 'Parsed title', durableId: 'd1' })
    harness.add(first)

    await harness.service.startAttention()
    first.status.set('running', undefined)
    first.pendingPermission.set(
      {
        requestId: 'r1',
        toolCallId: 't1',
        title: 'Run shell command',
        options: [],
      } as unknown as AcpPendingPermission,
      undefined,
    )
    first.status.set('idle', undefined)

    expect(harness.events).toEqual([
      {
        kind: 'attention',
        localId: 's1',
        durableId: 'd1',
        attentionKind: 'permission',
        title: 'Parsed title',
        agentName: 'Fake Agent',
        permissionTitle: 'Run shell command',
      },
    ])
    expect(first.timeline.get()).toEqual([])
  })

  it('debounces completion and stops after stopAttention', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startAttention()

    first.status.set('running', undefined)
    first.status.set('idle', undefined)
    expect(harness.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(harness.events).toEqual([
      {
        kind: 'attention',
        localId: 's1',
        attentionKind: 'completed',
        title: 'Session s1',
        agentName: 'Fake Agent',
      },
    ])

    await harness.service.stopAttention()
    harness.events.length = 0
    first.pendingElicitation.set({ request: {} } as unknown as AcpPendingElicitation, undefined)
    expect(harness.events).toHaveLength(0)
  })

  it('stops attention when the bridge is disposed', async () => {
    const harness = makeHarness()
    const first = makeSession('s1')
    harness.add(first)
    await harness.service.startAttention()

    harness.service.dispose()
    first.pendingElicitation.set({ request: {} } as unknown as AcpPendingElicitation, undefined)
    expect(harness.events).toHaveLength(0)
  })
})
