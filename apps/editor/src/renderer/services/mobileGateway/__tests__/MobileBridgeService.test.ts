import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  observableValue,
  type ILogger,
  type ILoggerService,
  type ISettableObservable,
} from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AcpMessage,
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
  pendingElicitation: ISettableObservable<undefined>
  status: ISettableObservable<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>
  isDormant: ISettableObservable<boolean>
  backgroundTaskCount: ISettableObservable<number>
  isReplayingHistory: ISettableObservable<boolean>
  sessionIdOnAgent: ISettableObservable<string | undefined>
}

function makeSession(
  id: string,
  options: { durableId?: string; title?: string } = {},
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
  const pendingElicitation = observableValue<undefined>('test.elicitation', undefined)
  const status = observableValue<'idle' | 'connecting' | 'running' | 'errored' | 'closed'>(
    'test.status',
    'idle',
  )
  const isDormant = observableValue<boolean>('test.dormant', false)
  const backgroundTaskCount = observableValue<number>('test.bg', 0)
  const isReplayingHistory = observableValue<boolean>('test.replay', false)
  const sessionIdOnAgent = observableValue<string | undefined>('test.durable', options.durableId)
  const session = {
    id,
    agentId: 'fake',
    title: options.title ?? `Session ${id}`,
    cwd: '/workspace/demo',
    authority: undefined,
    readOnly: false,
    timeline,
    toolCalls,
    plan,
    configOptions,
    usage,
    pendingPermission,
    pendingElicitation,
    status,
    isDormant,
    backgroundTaskCount,
    isReplayingHistory,
    sessionIdOnAgent,
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
  add(session: FakeSessionHarness): void
  remove(id: string): void
} {
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const history = observableValue<readonly AcpSessionHistoryEntry[]>('test.history', [])
  const live = new Map<string, IAcpSession>()
  const sessionService = {
    sessions,
    getById: (id: string) => live.get(id),
  } as unknown as IAcpSessionService
  const historyService = { entries: history } as unknown as IAcpSessionHistoryService
  const registry = {
    get: () => ({ id: 'fake', name: 'Fake Agent' }),
  } as unknown as IAcpAgentRegistry
  const loggerService = { createLogger: () => NULL_LOGGER } as unknown as ILoggerService
  const service = new MobileBridgeService(sessionService, historyService, registry, loggerService)
  const events: MobileBridgeEvent[] = []
  service.onDidChange((event) => events.push(event))
  return {
    service,
    sessions,
    history,
    events,
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
      { id: 'model', name: 'Model', type: 'select', currentValue: 'Model One' },
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
      toolCallId: 'tool-1',
      title: 'Run command',
      options: [{ optionId: 'allow', name: 'Allow' }],
      resolve: () => {},
      cancel: () => {},
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
    expect(cleared[0]).toStrictEqual({ type: 'permission_cleared' })
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
