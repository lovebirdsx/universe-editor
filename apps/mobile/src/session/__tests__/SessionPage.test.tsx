import {
  MOBILE_PROTOCOL_VERSION,
  type HelloOkFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import { CLEARED_FALLBACK_MS } from '../PermissionSheet.js'
import { MobileClient } from '../../state/mobileClient.js'
import { FakeTimers, FakeWebSocket, sentFrames } from '../../test/fakes.js'
import {
  agentMessage,
  sessionRef,
  sessionSnapshotFrame,
  sessionSummary,
  toolCall,
  userMessage,
} from '../../test/protocolFixtures.js'
import { strings } from '../../strings.js'
import { SESSION_DISPLAY_STORAGE_KEY } from '../sessionDisplay.js'
import { SessionPage, SESSION_LOAD_TIMEOUT_MS } from '../SessionPage.js'

const credentials: StoredCredentials = {
  deviceId: 'device-1',
  token: 'token-1',
  pcName: 'PC-A',
  deviceName: 'Phone',
  platform: 'other',
  protocolVersion: MOBILE_PROTOCOL_VERSION,
}

interface Harness {
  readonly client: MobileClient
  readonly socket: FakeWebSocket
  readonly timers: FakeTimers
}

function helloOkFrame(): HelloOkFrame {
  return {
    type: 'hello_ok',
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    serverVersion: '0.0.0-test',
    deviceId: 'device-1',
    serverTime: 1,
    capabilities: ['inbox', 'session'],
  }
}

function createHarness(): Harness {
  const timers = new FakeTimers()
  const sockets: FakeWebSocket[] = []
  const client = new MobileClient({
    credentials,
    url: 'ws://pc.example.com/ws',
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url)
      sockets.push(socket)
      return socket
    },
    timers,
    random: () => 0.5,
  })
  client.start()
  const socket = sockets[0]
  if (socket === undefined) throw new Error('no socket')
  socket.serverOpen()
  socket.serverSend(helloOkFrame())
  return { client, socket, timers }
}

function feed(socket: FakeWebSocket, frame: ServerFrame): void {
  act(() => {
    socket.serverSend(frame)
  })
}

function openPage(sessionKey = '1:s1'): {
  readonly harness: Harness
  readonly onBack: ReturnType<typeof vi.fn>
} {
  const harness = createHarness()
  feed(harness.socket, {
    type: 'inbox_snapshot',
    seq: 1,
    sessions: [sessionSummary('s1')],
  })
  const onBack = vi.fn()
  render(<SessionPage client={harness.client} sessionKey={sessionKey} onBack={onBack} />)
  return { harness, onBack }
}

describe('SessionPage snapshot rendering', () => {
  it('renders the header, user message and markdown reply', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [userMessage('m1', 'hello'), agentMessage('a1', 'echo: hello')],
      }),
    )

    expect(screen.getByRole('heading', { name: 'Session s1' })).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('echo: hello')).toBeTruthy()
    expect(screen.getByTestId('agent-markdown')).toBeTruthy()
  })

  it('defaults to only-message: hides thoughts and ordinary tool calls', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [
          userMessage('m1', 'hello'),
          { kind: 'message', id: 'th1', role: 'thought', text: 'thinking', streaming: false },
          toolCall('tool-1'),
          agentMessage('a1', 'answer'),
        ],
      }),
    )

    expect(screen.getByTestId('user-message')).toBeTruthy()
    expect(screen.getByTestId('agent-message')).toBeTruthy()
    expect(screen.queryByTestId('thought-item')).toBeNull()
    expect(screen.queryByTestId('tool-call-row')).toBeNull()
  })

  it('keeps key tool cards ungrouped in only-message mode', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [
          toolCall('d1', { requiresUserDecision: true }),
          toolCall('d2', { requiresUserDecision: true }),
          toolCall('d3', { toolKind: 'switch_mode' }),
        ],
      }),
    )

    expect(screen.getAllByTestId('tool-call-row')).toHaveLength(3)
    expect(screen.queryByTestId('tool-call-group')).toBeNull()
  })

  it('appends streaming text and drops the cursor when the stream settles', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, { timeline: [agentMessage('a1', 'echo: ', true)] }),
    )
    expect(document.querySelector('.streaming-cursor')).toBeTruthy()

    feed(harness.socket, {
      type: 'session_delta',
      seq: 2,
      ref: sessionRef('s1'),
      events: [
        {
          type: 'message_upsert',
          id: 'a1',
          role: 'agent',
          textAppend: 'hello',
          streaming: false,
        },
      ],
    })

    expect(screen.getByText('echo: hello')).toBeTruthy()
    expect(document.querySelector('.streaming-cursor')).toBeNull()
  })

  it('collapses consecutive tool calls and fetches a detail on expand (cached)', async () => {
    localStorage.setItem(SESSION_DISPLAY_STORAGE_KEY, 'full')
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [toolCall('t1'), toolCall('t2'), toolCall('t3')],
      }),
    )

    expect(screen.getByText(strings.toolCallGroupTitle(3))).toBeTruthy()
    fireEvent.click(screen.getByText(strings.toolCallGroupTitle(3)).closest('button')!)

    const rows = screen.getAllByTestId('tool-call-row')
    expect(rows).toHaveLength(3)
    fireEvent.click(within(rows[0]!).getByRole('button'))

    const command = sentFrames(harness.socket).find((frame) => frameType(frame) === 'command') as
      | { type: 'command'; requestId: string; kind: string; payload: unknown }
      | undefined
    expect(command).toMatchObject({
      kind: 'getToolCallDetail',
      payload: { toolCallId: 't1' },
    })

    feed(harness.socket, {
      type: 'command_result',
      requestId: command!.requestId,
      ok: true,
      result: {
        id: 't1',
        title: 'Tool t1',
        kind: 'execute',
        status: 'completed',
        text: '\u001b[31mhello\u001b[0m',
        diffs: [{ path: 'a.txt', oldText: 'old', newText: 'new' }],
      },
    })

    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    expect(screen.getByTestId('tool-call-diff')).toBeTruthy()

    // Collapse and expand again: the cached detail must not issue a second command.
    fireEvent.click(within(rows[0]!).getByRole('button'))
    fireEvent.click(within(rows[0]!).getByRole('button'))
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    expect(
      sentFrames(harness.socket).filter((frame) => frameType(frame) === 'command'),
    ).toHaveLength(1)
  })

  it('renders interactive approval and elicitation sheets', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        pendingPermission: {
          requestId: 'req-1',
          toolCallId: 't1',
          title: 'Run the command',
          options: [
            { optionId: 'allow', name: '允许一次', allowedOnMobile: true },
            { optionId: 'deny', name: '拒绝', allowedOnMobile: true },
          ],
        },
        pendingElicitation: {
          requestId: 'elicit-1',
          mode: 'text',
          message: 'Which branch?',
          title: 'Choose branch',
        },
      }),
    )

    expect(screen.getByText('等待你的审批')).toBeTruthy()
    expect(screen.getByText('Run the command')).toBeTruthy()
    expect(screen.getByText('Which branch?')).toBeTruthy()
    expect(screen.getByTestId('permission-sheet')).toBeTruthy()
    expect(screen.getByTestId('elicitation-sheet')).toBeTruthy()
    expect(screen.getAllByTestId('permission-option')).toHaveLength(2)
    expect(screen.getByText('允许一次').closest('button')).not.toBeNull()
  })

  it('closes the approval sheet when permission_cleared arrives', () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { pendingPermission: pendingPermission() }))

    fireEvent.click(screen.getAllByTestId('permission-option')[0]!)
    const command = sentFrames(harness.socket).find((frame) => frameType(frame) === 'command') as
      | { requestId: string; kind: string; payload: unknown }
      | undefined
    expect(command).toMatchObject({ kind: 'resolvePermission', payload: { requestId: 'req-1' } })
    expect(screen.getByText(strings.pendingSubmitting)).toBeTruthy()

    feed(harness.socket, {
      type: 'session_delta',
      seq: 2,
      ref: sessionRef('s1'),
      events: [
        { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'mobile' },
      ],
    })

    expect(screen.queryByTestId('permission-sheet')).toBeNull()
  })

  it('toasts when the request was handled on the PC', () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { pendingPermission: pendingPermission() }))

    feed(harness.socket, {
      type: 'session_delta',
      seq: 2,
      ref: sessionRef('s1'),
      events: [
        { type: 'permission_cleared', requestId: 'req-1', reason: 'selected', source: 'pc' },
      ],
    })

    expect(screen.queryByTestId('permission-sheet')).toBeNull()
    expect(screen.getByTestId('session-toast').textContent).toBe(strings.pendingResolvedElsewhere)
  })

  it('falls back to a fresh snapshot 3s after a tap without permission_cleared', async () => {
    vi.useFakeTimers()
    try {
      const { harness } = openPage()
      feed(harness.socket, sessionSnapshotFrame(1, { pendingPermission: pendingPermission() }))

      fireEvent.click(screen.getAllByTestId('permission-option')[0]!)
      const command = sentFrames(harness.socket).find((frame) => frameType(frame) === 'command') as
        | { requestId: string }
        | undefined
      feed(harness.socket, {
        type: 'command_result',
        requestId: command!.requestId,
        ok: true,
      })
      await act(async () => undefined)

      const before = sentFrames(harness.socket).filter(
        (frame) => frameType(frame) === 'subscribe_session',
      ).length
      act(() => {
        vi.advanceTimersByTime(CLEARED_FALLBACK_MS)
      })

      expect(screen.queryByTestId('permission-sheet')).toBeNull()
      const after = sentFrames(harness.socket).filter(
        (frame) => frameType(frame) === 'subscribe_session',
      ).length
      expect(after).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drives config chips, boolean switches and the high-risk picker', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        configOptions: [
          {
            id: 'mode',
            name: '模式',
            type: 'select',
            currentValue: '默认',
            allowedOnMobile: true,
            options: [
              { value: 'default', label: '默认', allowedOnMobile: true },
              { value: 'bypassPermissions', label: '完全访问', allowedOnMobile: false },
            ],
          },
          {
            id: 'web',
            name: '联网',
            type: 'boolean',
            currentValue: 'On',
            allowedOnMobile: true,
          },
        ],
      }),
    )

    expect(screen.getByTestId('config-chip').textContent).toContain('默认')
    const toggle = screen.getByTestId('config-switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)

    const command = sentFrames(harness.socket).find(
      (frame) =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['kind'] === 'setConfigOption',
    ) as { payload: unknown } | undefined
    expect(command?.payload).toMatchObject({ configId: 'web', value: false })

    fireEvent.click(screen.getByTestId('config-chip'))
    expect(screen.getByTestId('config-sheet')).toBeTruthy()
    const bypass = screen
      .getAllByTestId('config-value')
      .find((value) => value.getAttribute('data-value') === 'bypassPermissions')!
    expect((bypass as HTMLButtonElement).disabled).toBe(true)
    expect(bypass.textContent).toContain(strings.configNeedsPc)
  })

  it('renders a removed session and lets the user go back', () => {
    const { harness, onBack } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))
    feed(harness.socket, { type: 'session_removed', ref: sessionRef('s1') })

    expect(screen.getByText(strings.sessionRemovedTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: strings.sessionBackToInbox }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('resubscribes on a sequence gap', () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))
    const before = sentFrames(harness.socket).filter(
      (frame) => frameType(frame) === 'subscribe_session',
    ).length

    feed(harness.socket, {
      type: 'session_delta',
      seq: 3,
      ref: sessionRef('s1'),
      events: [],
    })
    const after = sentFrames(harness.socket).filter(
      (frame) => frameType(frame) === 'subscribe_session',
    ).length
    expect(after).toBe(before + 1)
  })

  it('resubscribes when the gateway asks for a resync', () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))
    const before = sentFrames(harness.socket).filter(
      (frame) => frameType(frame) === 'subscribe_session',
    ).length

    feed(harness.socket, {
      type: 'resync_required',
      scope: 'session',
      reason: 'backpressure',
      ref: sessionRef('s1'),
    })
    const after = sentFrames(harness.socket).filter(
      (frame) => frameType(frame) === 'subscribe_session',
    ).length
    expect(after).toBe(before + 1)
  })

  it('shows an error with retry after the snapshot timeout, and retry resubscribes', () => {
    vi.useFakeTimers()
    try {
      const { harness } = openPage()
      expect(screen.queryByTestId('session-load-failed')).toBeNull()

      act(() => {
        vi.advanceTimersByTime(SESSION_LOAD_TIMEOUT_MS)
      })
      expect(screen.getByTestId('session-load-failed')).toBeTruthy()
      expect(screen.getByText(strings.sessionLoadFailedTitle)).toBeTruthy()

      const before = sentFrames(harness.socket).filter(
        (frame) => frameType(frame) === 'subscribe_session',
      ).length
      fireEvent.click(screen.getByRole('button', { name: strings.sessionRetry }))

      const after = sentFrames(harness.socket).filter(
        (frame) => frameType(frame) === 'subscribe_session',
      ).length
      expect(after).toBe(before + 1)
      expect(screen.queryByTestId('session-load-failed')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the load error as soon as the gateway sends an invalid frame', () => {
    const { harness } = openPage()

    act(() => {
      harness.socket.serverSend('{not json')
    })

    expect(screen.getByTestId('session-load-failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: strings.sessionRetry })).toBeTruthy()
  })
})

function pendingPermission() {
  return {
    requestId: 'req-1',
    toolCallId: 't1',
    title: 'Run the command',
    options: [
      { optionId: 'allow-once', name: '允许一次', kind: 'allow_once', allowedOnMobile: true },
      {
        optionId: 'allow-with-updates',
        name: '总是允许',
        kind: 'allow_always',
        allowedOnMobile: false,
      },
    ],
  }
}

function frameType(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const type = (frame as Record<string, unknown>)['type']
  return typeof type === 'string' ? type : undefined
}
