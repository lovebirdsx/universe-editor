import {
  MOBILE_PROTOCOL_VERSION,
  type HelloOkFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  _resetComposerPrefillForTests,
  depositComposerPrefill,
  takeComposerPrefill,
} from '../composerPrefill.js'
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
    trusted: false,
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

function openPage(
  sessionKey = '1:s1',
  overrides: Partial<Parameters<typeof SessionPage>[0]> = {},
): {
  readonly harness: Harness
  readonly onBack: ReturnType<typeof vi.fn>
  readonly onFinished: ReturnType<typeof vi.fn>
} {
  const harness = createHarness()
  feed(harness.socket, {
    type: 'inbox_snapshot',
    seq: 1,
    sessions: [sessionSummary('s1')],
  })
  const onBack = vi.fn()
  const onFinished = vi.fn()
  render(
    <SessionPage
      client={harness.client}
      sessionKey={sessionKey}
      onBack={onBack}
      onFinished={onFinished}
      {...overrides}
    />,
  )
  return { harness, onBack, onFinished }
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

  it('shows the hidden activity while running and hides it when a card needs attention', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [
          userMessage('m1', 'hello'),
          { kind: 'message', id: 'th1', role: 'thought', text: 'thinking', streaming: true },
        ],
      }),
    )

    expect(screen.getByTestId('session-timeline-activity')).toBeTruthy()
    expect(screen.getByTestId('session-timeline-activity-primary').textContent).toBe(
      strings.activityThinking,
    )

    feed(harness.socket, {
      type: 'session_delta',
      seq: 2,
      ref: sessionRef('s1'),
      events: [
        {
          type: 'permission_upsert',
          permission: {
            requestId: 'req-1',
            toolCallId: 'tool-1',
            title: 'Run command',
            options: [{ optionId: 'allow', name: 'Allow', allowedOnMobile: true }],
          },
        },
      ],
    })
    expect(screen.queryByTestId('session-timeline-activity')).toBeNull()
  })

  it('hides the hidden activity once the session goes idle', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [
          userMessage('m1', 'hello'),
          { kind: 'message', id: 'th1', role: 'thought', text: 'thinking', streaming: true },
        ],
      }),
    )
    expect(screen.getByTestId('session-timeline-activity')).toBeTruthy()

    feed(harness.socket, {
      type: 'session_delta',
      seq: 2,
      ref: sessionRef('s1'),
      events: [
        {
          type: 'summary_changed',
          summary: sessionSummary('s1', {
            status: 'idle',
            displayStatus: 'idle',
            bucket: 'completed',
          }),
        },
      ],
    })
    expect(screen.queryByTestId('session-timeline-activity')).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: strings.sessionBack }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows the removed state when the removal precedes the snapshot', () => {
    const { harness } = openPage()
    feed(harness.socket, { type: 'session_removed', ref: sessionRef('s1') })

    expect(screen.getByText(strings.sessionRemovedTitle)).toBeTruthy()
  })

  it('reopens a removed durable session in place', async () => {
    const ref = sessionRef('s1', 1, 'durable-1')
    const { harness } = openPage('durable-1')
    feed(
      harness.socket,
      sessionSnapshotFrame(1, { summary: sessionSummary('s1', { ref }), timeline: [] }),
    )
    feed(harness.socket, { type: 'session_removed', ref })

    fireEvent.click(screen.getByTestId('session-reopen'))
    const command = sentFrames(harness.socket).find(
      (frame): frame is { type: 'command'; requestId: string; kind: string; payload: unknown } =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as { type?: unknown }).type === 'command' &&
        (frame as { kind?: unknown }).kind === 'openSession',
    )
    expect(command?.payload).toEqual({ durableId: 'durable-1', windowId: 1 })
    if (command === undefined) throw new Error('openSession was not sent')

    feed(harness.socket, {
      type: 'command_result',
      requestId: command.requestId,
      ok: true,
      result: { ref },
    })
    await waitFor(() => expect(screen.queryByText(strings.sessionRemovedTitle)).toBeNull())
    expect(
      sentFrames(harness.socket).find(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as { type?: unknown }).type === 'subscribe_session',
      ),
    ).toMatchObject({ type: 'subscribe_session', ref: { durableId: 'durable-1' } })
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

  it('gates image and file attachments from the session summary', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', {
          imageSupported: true,
          authority: 'ssh-remote',
        }),
      }),
    )

    expect(screen.getByTestId('composer-attach')).toBeTruthy()
    expect(screen.getByTestId('composer-photo-input')).toBeTruthy()
    expect(screen.queryByTestId('composer-file-input')).toBeNull()

    fireEvent.click(screen.getByTestId('composer-attach'))
    expect(screen.getByTestId('attachment-photos')).toBeTruthy()
    expect(screen.queryByTestId('attachment-files')).toBeNull()
  })

  it('uploads a photo and sends its id with the prompt', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'att-1',
            kind: 'image',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 3,
            createdAt: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { harness } = openPage()
      feed(
        harness.socket,
        sessionSnapshotFrame(1, {
          timeline: [],
          summary: sessionSummary('s1', { imageSupported: true }),
        }),
      )

      fireEvent.change(screen.getByTestId('composer-photo-input'), {
        target: { files: [new File(['abc'], 'shot.png', { type: 'image/png' })] },
      })
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByTestId('composer-input'), {
        target: { value: 'look' },
      })
      const send = screen.getByTestId('composer-send') as HTMLButtonElement
      await waitFor(() => expect(send.disabled).toBe(false))
      fireEvent.click(send)

      await waitFor(() => {
        const command = sentFrames(harness.socket).find(
          (frame) =>
            frameType(frame) === 'command' && (frame as { kind?: string }).kind === 'sendPrompt',
        ) as { payload: unknown } | undefined
        expect(command?.payload).toMatchObject({
          ref: { windowId: 1, localId: 's1' },
          text: 'look',
          attachmentIds: ['att-1'],
        })
      })
    } finally {
      vi.unstubAllGlobals()
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

  it('closes an idle session without a confirmation', async () => {
    const { harness, onFinished } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', {
          status: 'idle',
          displayStatus: 'idle',
          bucket: 'completed',
        }),
      }),
    )

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-close'))

    const command = sentFrames(harness.socket).find(
      (frame) =>
        frameType(frame) === 'command' && (frame as { kind?: string }).kind === 'closeSession',
    ) as { requestId: string; payload: unknown } | undefined
    expect(command?.payload).toStrictEqual({ ref: sessionRef('s1') })

    feed(harness.socket, {
      type: 'command_result',
      requestId: command!.requestId,
      ok: true,
    })
    await act(async () => undefined)
    expect(onFinished).toHaveBeenCalledWith('closed')
  })

  it('confirms before closing a running session', async () => {
    const { harness, onFinished } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-close'))
    expect(screen.getByTestId('session-close-sheet')).toBeTruthy()
    expect(
      sentFrames(harness.socket).some(
        (frame) =>
          frameType(frame) === 'command' && (frame as { kind?: string }).kind === 'closeSession',
      ),
    ).toBe(false)

    fireEvent.click(screen.getByTestId('session-close-sheet-confirm'))
    const command = sentFrames(harness.socket).find(
      (frame) =>
        frameType(frame) === 'command' && (frame as { kind?: string }).kind === 'closeSession',
    ) as { requestId: string } | undefined
    expect(command).toBeDefined()
    feed(harness.socket, {
      type: 'command_result',
      requestId: command!.requestId,
      ok: true,
    })
    await act(async () => undefined)
    expect(onFinished).toHaveBeenCalledWith('closed')
  })

  it('removes a session after confirmation', async () => {
    const { harness, onFinished } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-remove'))
    expect(screen.getByTestId('session-remove-sheet')).toBeTruthy()

    fireEvent.click(screen.getByTestId('session-remove-sheet-confirm'))
    const command = sentFrames(harness.socket).find(
      (frame) =>
        frameType(frame) === 'command' && (frame as { kind?: string }).kind === 'deleteSession',
    ) as { requestId: string } | undefined
    expect(command).toBeDefined()
    feed(harness.socket, {
      type: 'command_result',
      requestId: command!.requestId,
      ok: true,
    })
    await act(async () => undefined)
    expect(onFinished).toHaveBeenCalledWith('removed')
  })

  it('hides rename, close and remove for a read-only session', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { readOnly: true }),
      }),
    )

    fireEvent.click(screen.getByTestId('session-more'))
    expect(screen.queryByTestId('session-close')).toBeNull()
    expect(screen.queryByTestId('session-remove')).toBeNull()
    expect(screen.queryByTestId('session-rename')).toBeNull()
  })
})

interface SentCommand {
  readonly requestId: string
  readonly kind: string
  readonly payload: unknown
}

function commandFrames(socket: FakeWebSocket): SentCommand[] {
  return sentFrames(socket).filter(
    (frame) => frameType(frame) === 'command',
  ) as unknown as SentCommand[]
}

function commandFor(socket: FakeWebSocket, kind: string): SentCommand | undefined {
  return [...commandFrames(socket)].reverse().find((command) => command.kind === kind)
}

function respond(harness: Harness, kind: string, result?: unknown): void {
  const command = commandFor(harness.socket, kind)
  if (command === undefined) throw new Error(`no ${kind} command was sent`)
  feed(
    harness.socket,
    (result === undefined
      ? { type: 'command_result', requestId: command.requestId, ok: true }
      : { type: 'command_result', requestId: command.requestId, ok: true, result }) as ServerFrame,
  )
}

function anchoredUser(id: string, text: string, canFork: boolean) {
  return { ...userMessage(id, text), messageId: `msg-${id}`, canFork }
}

describe('SessionPage fork / rewind / side tasks', () => {
  beforeEach(() => {
    _resetComposerPrefillForTests()
  })

  it('forks from a user message and opens the new ref directly', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { forkSupported: true, bucket: 'completed' }),
        timeline: [anchoredUser('m1', 'hello', true)],
      }),
    )

    fireEvent.click(screen.getByTestId('user-message-actions'))
    fireEvent.click(screen.getByTestId('message-action-fork'))

    await waitFor(() => expect(commandFor(harness.socket, 'forkSession')).toBeDefined())
    expect(commandFor(harness.socket, 'forkSession')?.payload).toMatchObject({
      messageId: 'msg-m1',
    })

    const ref = { windowId: 1, localId: 's9', durableId: 'durable-fork' }
    respond(harness, 'forkSession', { ref })
    await waitFor(() => expect(onOpenSessionRef).toHaveBeenCalledWith(ref))
  })

  it('previews a rewind, applies it keeping files, and backfills the composer', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { rewindSupported: true }),
        timeline: [anchoredUser('m1', 'hello', false)],
      }),
    )

    fireEvent.click(screen.getByTestId('user-message-actions'))
    fireEvent.click(screen.getByTestId('message-action-rewind'))

    await waitFor(() => expect(commandFor(harness.socket, 'previewRewind')).toBeDefined())
    expect(commandFor(harness.socket, 'previewRewind')?.payload).toMatchObject({
      messageId: 'msg-m1',
    })
    respond(harness, 'previewRewind', {
      canRewind: true,
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    })

    await waitFor(() => expect(screen.getByTestId('rewind-keep')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rewind-keep'))

    await waitFor(() => expect(commandFor(harness.socket, 'rewindSession')).toBeDefined())
    expect(commandFor(harness.socket, 'rewindSession')?.payload).toMatchObject({
      messageId: 'msg-m1',
      rewindFiles: false,
    })
    respond(harness, 'rewindSession', { canRewind: true, text: 'hello' })

    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('hello'),
    )
    expect(screen.getByTestId('session-toast').textContent).toBe(strings.rewindDone)
    expect(onOpenSessionRef).not.toHaveBeenCalled()
  })

  it('creates a side task from an agent message and deposits its quote', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { forkSupported: true }),
        timeline: [userMessage('m1', 'hello'), agentMessage('a1', 'the answer')],
      }),
    )

    fireEvent.click(screen.getByTestId('agent-message-actions'))
    fireEvent.click(screen.getByTestId('message-action-side-task'))

    await waitFor(() => expect(commandFor(harness.socket, 'createSideTask')).toBeDefined())
    expect(commandFor(harness.socket, 'createSideTask')?.payload).toMatchObject({
      quote: 'the answer',
    })

    respond(harness, 'createSideTask', {
      ref: { windowId: 1, localId: 's2', durableId: 'durable-side-9' },
    })
    await waitFor(() => expect(onOpenSessionRef).toHaveBeenCalled())
    expect(takeComposerPrefill('durable-side-9')).toBe('> the answer\n\n')
  })

  it('forks from the end through the session menu', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { forkSupported: true, bucket: 'completed' }),
        timeline: [userMessage('m1', 'hello')],
      }),
    )

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-fork-tip'))

    await waitFor(() => expect(commandFor(harness.socket, 'forkSession')).toBeDefined())
    expect(commandFor(harness.socket, 'forkSession')?.payload).not.toHaveProperty('messageId')

    const ref = { windowId: 1, localId: 's9', durableId: 'durable-fork' }
    respond(harness, 'forkSession', { ref })
    await waitFor(() => expect(onOpenSessionRef).toHaveBeenCalledWith(ref))
  })

  it('opens a side task from the parent list', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { forkSupported: true, sideTaskChildCount: 1 }),
        timeline: [],
      }),
    )

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-side-tasks'))

    await waitFor(() => expect(commandFor(harness.socket, 'listSideTasks')).toBeDefined())
    respond(harness, 'listSideTasks', [
      { id: 'durable-side-1', title: 'Side chat', lastUsedAt: 1_000, live: true },
    ])

    await screen.findByTestId('side-task-row')
    fireEvent.click(screen.getByTestId('side-task-open'))

    await waitFor(() => expect(commandFor(harness.socket, 'openSideTask')).toBeDefined())
    expect(commandFor(harness.socket, 'openSideTask')?.payload).toMatchObject({
      sideTaskId: 'durable-side-1',
    })
    const ref = { windowId: 1, localId: 's2', durableId: 'durable-side-1' }
    respond(harness, 'openSideTask', { ref })
    await waitFor(() => expect(onOpenSessionRef).toHaveBeenCalledWith(ref))
  })

  it('deletes a side task and reloads the list', async () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { forkSupported: true, sideTaskChildCount: 1 }),
        timeline: [],
      }),
    )

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-side-tasks'))
    await waitFor(() => expect(commandFor(harness.socket, 'listSideTasks')).toBeDefined())
    respond(harness, 'listSideTasks', [
      { id: 'durable-side-1', title: 'Side chat', lastUsedAt: 1_000, live: false },
    ])

    await screen.findByTestId('side-task-row')
    fireEvent.click(screen.getByTestId('side-task-delete'))
    fireEvent.click(screen.getByTestId('side-task-delete-confirm'))

    await waitFor(() => expect(commandFor(harness.socket, 'deleteSideTask')).toBeDefined())
    expect(commandFor(harness.socket, 'deleteSideTask')?.payload).toMatchObject({
      sideTaskId: 'durable-side-1',
    })
    respond(harness, 'deleteSideTask')

    await waitFor(() =>
      expect(
        commandFrames(harness.socket).filter((command) => command.kind === 'listSideTasks'),
      ).toHaveLength(2),
    )
    respond(harness, 'listSideTasks', [])
    await waitFor(() => expect(screen.getByTestId('side-task-empty')).toBeTruthy())
  })

  it('shows the parent chip for a side task and navigates to the parent', async () => {
    const onOpenSessionRef = vi.fn()
    const { harness } = openPage('1:s1', { onOpenSessionRef })
    const parent = sessionSummary('p1', {
      ref: sessionRef('p1', 1, 'durable-parent'),
      title: 'Parent session',
    })
    feed(harness.socket, { type: 'inbox_snapshot', seq: 2, sessions: [parent] })
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { sideTaskOf: 'durable-parent' }),
        timeline: [],
      }),
    )

    const chip = screen.getByTestId('session-parent-chip')
    expect(chip.textContent).toBe(strings.sideTaskParent('Parent session'))
    fireEvent.click(chip)
    expect(onOpenSessionRef).toHaveBeenCalledWith(parent.ref)
  })

  it('subscribes with a command-returned ref and consumes its prefill under StrictMode', async () => {
    const initialRef = { windowId: 1, localId: 's9', durableId: 'durable-fork' }
    const harness = createHarness()
    depositComposerPrefill('durable-fork', '> quoted\n\n')

    render(
      <StrictMode>
        <SessionPage
          client={harness.client}
          sessionKey="durable-fork"
          initialRef={initialRef}
          onBack={vi.fn()}
          onFinished={vi.fn()}
        />
      </StrictMode>,
    )
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s9', { ref: initialRef }),
        timeline: [],
      }),
    )

    const subscribe = sentFrames(harness.socket).find(
      (frame) => frameType(frame) === 'subscribe_session',
    ) as { readonly ref?: unknown } | undefined
    expect(subscribe?.ref).toEqual(initialRef)
    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(
        '> quoted\n\n',
      ),
    )
  })

  it('does not carry a backfill into the next session', async () => {
    const harness = createHarness()
    feed(harness.socket, { type: 'inbox_snapshot', seq: 1, sessions: [sessionSummary('s1')] })
    depositComposerPrefill('1:s1', 'leaked prompt')

    const { rerender } = render(
      <SessionPage
        client={harness.client}
        sessionKey="1:s1"
        onBack={vi.fn()}
        onFinished={vi.fn()}
      />,
    )
    feed(harness.socket, sessionSnapshotFrame(1, { summary: sessionSummary('s1'), timeline: [] }))
    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(
        'leaked prompt',
      ),
    )

    rerender(
      <SessionPage
        client={harness.client}
        sessionKey="1:s2"
        onBack={vi.fn()}
        onFinished={vi.fn()}
      />,
    )
    feed(harness.socket, sessionSnapshotFrame(1, { summary: sessionSummary('s2'), timeline: [] }))

    await waitFor(() =>
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(''),
    )
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
