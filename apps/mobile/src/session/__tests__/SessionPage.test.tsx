import {
  MOBILE_PROTOCOL_VERSION,
  type HelloOkFrame,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import { writeClipboardImage, writeClipboardText } from '../../clipboard.js'
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
import {
  MessageImageTooLargeError,
  MessageImageUnavailableError,
  renderMessageImage,
} from '../messageImage.js'
import { SESSION_DISPLAY_STORAGE_KEY } from '../sessionDisplay.js'
import {
  SESSION_CLOSE_CONFIRM_STORAGE_KEY,
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
} from '../sessionConfirm.js'
import { SessionPage, SESSION_LOAD_TIMEOUT_MS } from '../SessionPage.js'

vi.mock('../../clipboard.js', () => ({
  writeClipboardText: vi.fn(),
  writeClipboardImage: vi.fn(),
}))
vi.mock('../messageImage.js', () => ({
  renderMessageImage: vi.fn(),
  MessageImageTooLargeError: class MessageImageTooLargeError extends Error {},
  MessageImageUnavailableError: class MessageImageUnavailableError extends Error {},
}))

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

  it('passes the agent command list to the composer', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [],
        availableCommands: [{ name: 'compact', description: 'Compact the conversation' }],
      }),
    )

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '/' } })

    expect(screen.getByTestId('composer-command-panel')).toBeTruthy()
    expect(screen.getByText('/compact')).toBeTruthy()
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
            options: [{ optionId: 'allow', name: 'Allow' }],
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
            { optionId: 'allow', name: '允许一次' },
            { optionId: 'deny', name: '拒绝' },
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

  it('drives config chips, boolean switches and the config picker', () => {
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
            options: [
              { value: 'default', label: '默认' },
              { value: 'bypassPermissions', label: '完全访问' },
            ],
          },
          {
            id: 'web',
            name: '联网',
            type: 'boolean',
            currentValue: 'On',
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
    expect((bypass as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(bypass)

    const modeCommand = sentFrames(harness.socket)
      .filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          (frame as Record<string, unknown>)['kind'] === 'setConfigOption',
      )
      .at(-1) as { payload: unknown } | undefined
    expect(modeCommand?.payload).toMatchObject({
      configId: 'mode',
      value: 'bypassPermissions',
    })
  })

  it('renders a removed session and lets the user go back', () => {
    const { harness, onBack } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))
    feed(harness.socket, { type: 'session_removed', ref: sessionRef('s1') })

    expect(screen.getByText(strings.sessionRemovedTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: strings.sessionBack }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('reopens a removed session with its closed-workspace hint', async () => {
    const ref = sessionRef('s1', 1, 'durable-1')
    const { harness } = openPage('durable-1', {
      workspaceFolder: 'file:///workspace/demo',
      workspaceAuthority: 'devhost',
    })
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
    expect(command?.payload).toEqual({
      durableId: 'durable-1',
      windowId: 1,
      folder: 'file:///workspace/demo',
      authority: 'devhost',
    })
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
    const input = screen.getByTestId('composer-attachment-input') as HTMLInputElement
    expect(input.accept).toBe('image/*')
  })

  it('lets a local session pick images and files in one system sheet', () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', { imageSupported: true }),
      }),
    )

    expect(screen.getByTestId('composer-attach')).toBeTruthy()
    const input = screen.getByTestId('composer-attachment-input') as HTMLInputElement
    expect(input.hasAttribute('accept')).toBe(false)
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

      fireEvent.change(screen.getByTestId('composer-attachment-input'), {
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
    expect(onFinished).toHaveBeenCalled()
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
    expect(onFinished).toHaveBeenCalled()
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
    expect(onFinished).toHaveBeenCalled()
  })

  it('closes a running session directly once the close preference is off', async () => {
    setSessionCloseConfirmEnabled(false)
    const { harness, onFinished } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-close'))

    expect(screen.queryByTestId('session-close-sheet')).toBeNull()
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
    expect(onFinished).toHaveBeenCalled()
  })

  it('removes a session directly once the remove preference is off', async () => {
    setSessionRemoveConfirmEnabled(false)
    const { harness, onFinished } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-remove'))

    expect(screen.queryByTestId('session-remove-sheet')).toBeNull()
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
    expect(onFinished).toHaveBeenCalled()
  })

  it('persists never-ask from the close confirmation', () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-close'))
    fireEvent.click(screen.getByTestId('session-close-sheet-never-ask'))
    fireEvent.click(screen.getByTestId('session-close-sheet-confirm'))

    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('never')
  })

  it('keeps removal confirmation when only the close preference is off', () => {
    setSessionCloseConfirmEnabled(false)
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-remove'))

    expect(screen.getByTestId('session-remove-sheet')).toBeTruthy()
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
    expect(screen.queryByTestId('session-push-branch')).toBeNull()
  })

  it('opens the push-branch sheet from the session menu', async () => {
    const { harness } = openPage()
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [] }))

    fireEvent.click(screen.getByTestId('session-more'))
    fireEvent.click(screen.getByTestId('session-push-branch'))

    await waitFor(() => expect(commandFor(harness.socket, 'previewPushBranch')).toBeDefined())
    expect(commandFor(harness.socket, 'previewPushBranch')?.payload).toMatchObject({
      ref: sessionRef('s1'),
    })
    respond(harness, 'previewPushBranch', {
      source: {
        worktreeName: 'main',
        branch: 'tasks/abc',
        head: 'abc12345',
        dirty: false,
        changedFileCount: 0,
        untrackedCount: 0,
        isMainWorktree: false,
      },
      remote: { name: 'origin', branch: 'tasks/abc', exists: false, ahead: 0, behind: 0 },
      blockers: [],
      warnings: [],
      expectation: {
        branch: 'tasks/abc',
        head: 'abc12345',
        remote: 'origin',
        remoteBranch: 'tasks/abc',
      },
    })

    await screen.findByTestId('push-branch-sheet')
    expect((screen.getByTestId('push-branch-remote-name') as HTMLInputElement).value).toBe(
      'tasks/abc',
    )
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

describe('SessionPage message copy', () => {
  beforeEach(() => {
    vi.mocked(writeClipboardText).mockReset().mockResolvedValue(true)
    vi.mocked(writeClipboardImage).mockReset().mockResolvedValue(true)
    vi.mocked(renderMessageImage)
      .mockReset()
      .mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  })

  function openSheet(harness: Harness, testId = 'user-message-actions'): void {
    feed(harness.socket, sessionSnapshotFrame(1, { timeline: [userMessage('m1', 'hello')] }))
    fireEvent.click(screen.getByTestId(testId))
  }

  it('copies the raw message text and closes the sheet', async () => {
    const { harness } = openPage()
    openSheet(harness)

    fireEvent.click(screen.getByTestId('message-action-copy-text'))

    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(strings.messageCopyTextDone),
    )
    expect(writeClipboardText).toHaveBeenCalledWith('hello')
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull()
  })

  it('keeps the sheet open and reports a text copy failure', async () => {
    vi.mocked(writeClipboardText).mockResolvedValue(false)
    const { harness } = openPage()
    openSheet(harness)

    fireEvent.click(screen.getByTestId('message-action-copy-text'))

    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(strings.messageCopyTextFailed),
    )
    expect(screen.getByTestId('message-actions-sheet')).toBeTruthy()
  })

  it('starts the clipboard write synchronously and reports the image as copied', async () => {
    const { harness } = openPage()
    feed(
      harness.socket,
      sessionSnapshotFrame(1, {
        timeline: [userMessage('m1', 'hello'), agentMessage('a1', 'the answer')],
      }),
    )
    fireEvent.click(screen.getByTestId('agent-message-actions'))
    fireEvent.click(screen.getByTestId('message-action-copy-image'))

    // WebKit needs the write inside the click stack, before the capture resolves.
    expect(renderMessageImage).toHaveBeenCalledTimes(1)
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeClipboardImage).mock.calls[0]?.[0]).toBeInstanceOf(Promise)

    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(strings.messageCopyImageDone),
    )
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull()
    expect(screen.queryByTestId('copy-image-preview')).toBeNull()
  })

  it('opens the preview overlay when the clipboard cannot take the image', async () => {
    vi.mocked(writeClipboardImage).mockResolvedValue(false)
    const { harness } = openPage()
    openSheet(harness)

    fireEvent.click(screen.getByTestId('message-action-copy-image'))

    await screen.findByTestId('copy-image-preview')
    expect(screen.queryByTestId('message-actions-sheet')).toBeNull()
  })

  it('maps capture failures to useful messages', async () => {
    vi.mocked(renderMessageImage).mockRejectedValue(new MessageImageTooLargeError())
    const { harness } = openPage()
    openSheet(harness)

    fireEvent.click(screen.getByTestId('message-action-copy-image'))

    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(
        strings.messageCopyImageTooLarge,
      ),
    )
    expect(screen.getByTestId('message-actions-sheet')).toBeTruthy()
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)

    vi.mocked(renderMessageImage).mockRejectedValue(new MessageImageUnavailableError())
    fireEvent.click(screen.getByTestId('message-action-copy-image'))
    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(
        strings.messageCopyImageUnavailable,
      ),
    )

    vi.mocked(renderMessageImage).mockRejectedValue(new Error('boom'))
    fireEvent.click(screen.getByTestId('message-action-copy-image'))
    await waitFor(() =>
      expect(screen.getByTestId('session-toast').textContent).toBe(strings.messageCopyImageFailed),
    )
  })
})

function pendingPermission() {
  return {
    requestId: 'req-1',
    toolCallId: 't1',
    title: 'Run the command',
    options: [
      { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
      {
        optionId: 'allow-with-updates',
        name: '总是允许',
        kind: 'allow_always',
      },
    ],
  }
}

function frameType(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const type = (frame as Record<string, unknown>)['type']
  return typeof type === 'string' ? type : undefined
}

describe('SessionPage session settings', () => {
  const settingsResult = {
    canEdit: true,
    subagentModel: { supported: true, current: 'sonnet', candidates: ['sonnet', 'opus'] },
    mcp: {
      pool: [
        { name: 'shared', transport: 'stdio', defaultDisabled: false },
        { name: 'docs', transport: 'http', defaultDisabled: true },
      ],
      selection: null,
      enabled: ['shared'],
      live: [{ name: 'shared', status: 'connected', transport: 'stdio' }],
    },
  }

  function commands(socket: FakeWebSocket): Array<{
    requestId: string
    kind: string
    payload: Record<string, unknown>
  }> {
    return sentFrames(socket).filter((frame) => frameType(frame) === 'command') as Array<{
      requestId: string
      kind: string
      payload: Record<string, unknown>
    }>
  }

  function openSessionPage(
    summaryOverrides: Partial<Parameters<typeof sessionSummary>[1]> = {},
  ): Harness {
    const page = openPage()
    feed(
      page.harness.socket,
      sessionSnapshotFrame(1, {
        summary: sessionSummary('s1', summaryOverrides),
        timeline: [],
      }),
    )
    return page.harness
  }

  function replySettings(socket: FakeWebSocket, requestId: string, result: unknown): void {
    feed(socket, { type: 'command_result', requestId, ok: true, result })
  }

  it('queries settings only after a chip is opened', async () => {
    const harness = openSessionPage()
    expect(commands(harness.socket)).toHaveLength(0)

    fireEvent.click(screen.getByTestId('mcp-chip'))
    const command = commands(harness.socket).at(-1)!
    expect(command).toMatchObject({
      kind: 'getSessionSettings',
      payload: { ref: { windowId: 1, localId: 's1' } },
    })
    replySettings(harness.socket, command.requestId, settingsResult)

    await waitFor(() => expect(screen.getByTestId('mcp-sheet')).toBeTruthy())
    expect(screen.getByTestId('mcp-chip').textContent).toContain('1/2')
  })

  it('shows the subagent chip only for claude-code sessions', async () => {
    const harness = openSessionPage({ agentId: 'claude-code' })
    expect(screen.getByTestId('subagent-chip')).toBeTruthy()
    expect(screen.getByTestId('mcp-chip')).toBeTruthy()

    fireEvent.click(screen.getByTestId('subagent-chip'))
    const command = commands(harness.socket).at(-1)!
    expect(command.kind).toBe('getSessionSettings')
    replySettings(harness.socket, command.requestId, settingsResult)

    await waitFor(() => expect(screen.getByTestId('subagent-sheet')).toBeTruthy())
    expect(screen.getByTestId('subagent-chip').textContent).toContain('sonnet')
  })

  it('has no subagent chip for other agents', () => {
    const harness = openSessionPage()
    expect(harness.client).toBeTruthy()
    expect(screen.queryByTestId('subagent-chip')).toBeNull()
    expect(screen.getByTestId('mcp-chip')).toBeTruthy()
  })

  it('hides both chips on a read-only session', async () => {
    openSessionPage({ readOnly: true })
    expect(screen.queryByTestId('subagent-chip')).toBeNull()
    expect(screen.queryByTestId('mcp-chip')).toBeNull()
  })

  it('retries a failed settings load', async () => {
    const harness = openSessionPage()
    fireEvent.click(screen.getByTestId('mcp-chip'))
    const first = commands(harness.socket).at(-1)!
    feed(harness.socket, {
      type: 'command_result',
      requestId: first.requestId,
      ok: false,
      error: 'internal',
    })
    await waitFor(() => expect(screen.getByTestId('session-settings-error')).toBeTruthy())

    fireEvent.click(screen.getByTestId('session-settings-retry'))
    const second = commands(harness.socket).at(-1)!
    expect(second.kind).toBe('getSessionSettings')
    expect(second.requestId).not.toBe(first.requestId)
    replySettings(harness.socket, second.requestId, settingsResult)

    await waitFor(() => expect(screen.getByTestId('mcp-sheet')).toBeTruthy())
  })

  it('sends a toggled MCP whitelist and updates the chip optimistically', async () => {
    const harness = openSessionPage()
    fireEvent.click(screen.getByTestId('mcp-chip'))
    const settingsCommand = commands(harness.socket).at(-1)!
    replySettings(harness.socket, settingsCommand.requestId, settingsResult)
    await waitFor(() => expect(screen.getByTestId('mcp-sheet')).toBeTruthy())

    const docsRow = screen
      .getAllByTestId('mcp-server-row')
      .find((row) => row.getAttribute('data-name') === 'docs')!
    fireEvent.click(docsRow.querySelector('input')!)

    const write = commands(harness.socket).at(-1)!
    expect(write).toMatchObject({
      kind: 'setSessionMcpServers',
      payload: { ref: { windowId: 1, localId: 's1' }, servers: ['shared', 'docs'] },
    })
    expect((docsRow.querySelector('input') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('mcp-chip').textContent).toContain('2/2')

    feed(harness.socket, { type: 'command_result', requestId: write.requestId, ok: true })
    await waitFor(() => expect(screen.getByTestId('mcp-chip').textContent).toContain('2/2'))
  })

  it('rolls an MCP toggle back when the write fails', async () => {
    const harness = openSessionPage()
    fireEvent.click(screen.getByTestId('mcp-chip'))
    const settingsCommand = commands(harness.socket).at(-1)!
    replySettings(harness.socket, settingsCommand.requestId, settingsResult)
    await waitFor(() => expect(screen.getByTestId('mcp-sheet')).toBeTruthy())

    const docsRow = screen
      .getAllByTestId('mcp-server-row')
      .find((row) => row.getAttribute('data-name') === 'docs')!
    fireEvent.click(docsRow.querySelector('input')!)
    const write = commands(harness.socket).at(-1)!
    feed(harness.socket, {
      type: 'command_result',
      requestId: write.requestId,
      ok: false,
      error: 'session_read_only',
    })

    await waitFor(() =>
      expect((docsRow.querySelector('input') as HTMLInputElement).checked).toBe(false),
    )
    expect(screen.getByTestId('mcp-chip').textContent).toContain('1/2')
  })

  it('hides the MCP chip once the pool turns out to be empty', async () => {
    const harness = openSessionPage()
    fireEvent.click(screen.getByTestId('mcp-chip'))
    const command = commands(harness.socket).at(-1)!
    replySettings(harness.socket, command.requestId, {
      ...settingsResult,
      mcp: { pool: [], selection: null, enabled: [], live: [] },
    })

    await waitFor(() => expect(screen.getByTestId('mcp-sheet')).toBeTruthy())
    expect(screen.getByText(strings.mcpEmpty)).toBeTruthy()
    expect(screen.queryByTestId('mcp-chip')).toBeNull()
  })
})
