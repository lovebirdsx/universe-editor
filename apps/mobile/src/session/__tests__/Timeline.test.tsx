import type {
  MobileTimelineItem,
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MobileClient } from '../../state/mobileClient.js'
import { strings } from '../../strings.js'
import { Timeline } from '../Timeline.js'

function toolCall(
  id: string,
  overrides: Partial<MobileTimelineToolCallItem> = {},
): MobileTimelineToolCallItem {
  return {
    kind: 'toolCall',
    id,
    title: `Tool ${id}`,
    toolKind: 'execute',
    status: 'completed',
    hasDetail: true,
    ...overrides,
  }
}

function userMessage(
  id: string,
  text: string,
  overrides: Partial<MobileTimelineItem & { kind: 'message' }> = {},
): MobileTimelineItem {
  return { kind: 'message', id, role: 'user', text, streaming: false, ...overrides }
}

const clientMock = {
  requestToolCallDetail: vi.fn(),
  fetchAttachmentBlob: vi.fn<(attachmentId: string) => Promise<Blob>>(),
  serverNow: vi.fn(() => 1_000_000),
}
const client = clientMock as unknown as Pick<
  MobileClient,
  'requestToolCallDetail' | 'fetchAttachmentBlob' | 'serverNow'
>

function renderTimeline(
  timeline: readonly MobileTimelineItem[],
  displayMode: 'onlyMessage' | 'full',
  overrides: Partial<Parameters<typeof Timeline>[0]> = {},
): void {
  render(
    <Timeline
      sessionKey="1:s1"
      timeline={timeline}
      displayMode={displayMode}
      truncated={false}
      client={client}
      {...overrides}
    />,
  )
}

describe('Timeline mobile attachments', () => {
  it('renders an image thumbnail fetched as a blob URL', async () => {
    clientMock.fetchAttachmentBlob.mockResolvedValue(new Blob(['abc'], { type: 'image/png' }))
    renderTimeline(
      [
        userMessage('m1', '', {
          attachments: [
            {
              id: 'att-1',
              kind: 'image',
              name: 'shot.png',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        }),
      ] as MobileTimelineItem[],
      'full',
    )

    expect(screen.getByTestId('user-attachments')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId('user-attachment-image').querySelector('img')?.src).toMatch(
        /^blob:/,
      ),
    )
    expect(clientMock.fetchAttachmentBlob).toHaveBeenCalledWith('att-1')
    expect(screen.queryByText(strings.messageNonText)).toBeNull()
  })

  it('renders a file card with name and size and no empty text paragraph', () => {
    renderTimeline(
      [
        userMessage('m1', '', {
          attachments: [
            {
              id: 'att-2',
              kind: 'file',
              name: 'notes.txt',
              mimeType: 'text/plain',
              size: 1536,
            },
          ],
        }),
      ] as MobileTimelineItem[],
      'full',
    )

    const card = screen.getByTestId('user-attachment-file')
    expect(card.textContent).toContain('notes.txt')
    expect(card.textContent).toContain('1.5 KB')
    expect(document.querySelector('.message__text')).toBeNull()
  })

  it('falls back to a file card when the image cannot be loaded', async () => {
    clientMock.fetchAttachmentBlob.mockRejectedValue(new Error('gone'))
    renderTimeline(
      [
        userMessage('m1', 'caption', {
          attachments: [
            {
              id: 'att-3',
              kind: 'image',
              name: 'missing.png',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        }),
      ] as MobileTimelineItem[],
      'full',
    )

    await waitFor(() =>
      expect(screen.getByTestId('user-attachment-image').textContent).toContain(
        strings.attachmentImageLoadFailed,
      ),
    )
    expect(screen.getByText('caption')).toBeTruthy()
  })
})

function anchoredUser(
  id: string,
  text: string,
  overrides: Partial<MobileTimelineMessageItem> = {},
): MobileTimelineMessageItem {
  return {
    kind: 'message',
    id,
    role: 'user',
    text,
    streaming: false,
    messageId: `msg-${id}`,
    ...overrides,
  }
}

describe('Timeline display modes', () => {
  it('filters before pagination so hidden tail items do not fake load-earlier', () => {
    const timeline: MobileTimelineItem[] = [
      ...Array.from({ length: 250 }, (_, index) => toolCall(`t${index}`)),
      userMessage('m1', 'hello'),
    ]
    renderTimeline(timeline, 'onlyMessage')

    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByText(strings.loadEarlier)).toBeNull()
    expect(screen.queryByTestId('tool-call-row')).toBeNull()
  })

  it('shows load-earlier based on the filtered visible count', () => {
    const timeline = Array.from({ length: 250 }, (_, index) =>
      userMessage(`m${index}`, `hello ${index}`),
    )
    renderTimeline(timeline, 'full')

    expect(screen.getByText(strings.loadEarlier)).toBeTruthy()
  })

  it('keeps key tool cards as individual rows in only-message mode', () => {
    renderTimeline(
      [
        toolCall('d1', { requiresUserDecision: true }),
        toolCall('d2', { subagent: true }),
        toolCall('d3', { toolKind: 'switch_mode' }),
      ],
      'onlyMessage',
    )

    expect(screen.getAllByTestId('tool-call-row')).toHaveLength(3)
    expect(screen.queryByTestId('tool-call-group')).toBeNull()
  })

  it('keeps grouping consecutive tools in full mode', () => {
    renderTimeline([toolCall('t1'), toolCall('t2'), toolCall('t3')], 'full')

    expect(screen.getByTestId('tool-call-group')).toBeTruthy()
    expect(screen.getByText(strings.toolCallGroupTitle(3))).toBeTruthy()
  })
})

describe('Timeline hidden activity', () => {
  it('shows the current thought below a running only-message timeline', () => {
    renderTimeline(
      [
        userMessage('m1', 'hello'),
        {
          kind: 'message',
          id: 'th1',
          role: 'thought',
          text: '\n  Reading the parser  \nmore',
          streaming: true,
        },
      ],
      'onlyMessage',
      { active: true },
    )

    expect(screen.getByTestId('session-timeline-activity')).toBeTruthy()
    expect(screen.getByTestId('session-timeline-activity-primary').textContent).toBe(
      strings.activityThinking,
    )
    expect(screen.getByTestId('session-timeline-activity-detail').textContent).toBe(
      'Reading the parser',
    )
  })

  it('shows a running hidden tool with its path and elapsed time', () => {
    clientMock.serverNow.mockReturnValue(1_005_000)
    renderTimeline(
      [
        userMessage('m1', 'hello'),
        toolCall('t1', {
          status: 'in_progress',
          title: 'Edit parser',
          locations: [{ path: 'src/parser.ts', line: 42 }],
          startedAt: 1_000_000,
        }),
      ],
      'onlyMessage',
      { active: true },
    )

    expect(screen.getByTestId('session-timeline-activity-primary').textContent).toBe('Edit parser')
    expect(screen.getByTestId('session-timeline-activity-detail').textContent).toBe(
      'src/parser.ts:42 · 5s',
    )
  })

  it('shows the previous settled tool when the hidden tail failed', () => {
    renderTimeline(
      [
        userMessage('m1', 'hello'),
        toolCall('t1', {
          status: 'failed',
          title: 'Bash',
          preview: '```console\nboom\n```',
          durationMs: 2_000,
        }),
      ],
      'onlyMessage',
      { active: true },
    )

    expect(screen.getByTestId('session-timeline-activity-primary').textContent).toBe(
      strings.activityThinking,
    )
    expect(screen.getByTestId('session-timeline-activity-detail').textContent).toBe(
      `上一步 Bash · 失败：boom · 2s`,
    )
  })

  it('keeps an empty detail slot so activity swaps do not change the row height', () => {
    renderTimeline(
      [userMessage('m1', 'hello'), toolCall('t1', { status: 'in_progress', title: 'Bash' })],
      'onlyMessage',
      { active: true },
    )

    expect(screen.getByTestId('session-timeline-activity-primary').textContent).toBe('Bash')
    expect(screen.getByTestId('session-timeline-activity-detail').textContent).toBe('')
  })

  it('does not show the row in full mode', () => {
    renderTimeline(
      [userMessage('m1', 'hello'), toolCall('t1', { status: 'in_progress' })],
      'full',
      { active: true },
    )
    expect(screen.queryByTestId('session-timeline-activity')).toBeNull()
  })

  it('does not show the row when the session is inactive', () => {
    renderTimeline(
      [userMessage('m1', 'hello'), toolCall('t1', { status: 'in_progress' })],
      'onlyMessage',
    )
    expect(screen.queryByTestId('session-timeline-activity')).toBeNull()
  })
})

describe('Timeline message actions', () => {
  it('renders no action buttons without a handler', () => {
    renderTimeline([anchoredUser('m1', 'hello', { canFork: true })], 'onlyMessage')
    expect(screen.queryByTestId('user-message-actions')).toBeNull()
    expect(screen.queryByTestId('agent-message-actions')).toBeNull()
  })

  it('offers actions on a forked user message and passes the item back', () => {
    const onOpenMessageActions = vi.fn()
    renderTimeline([anchoredUser('m1', 'hello', { canFork: true })], 'onlyMessage', {
      onOpenMessageActions,
    })

    fireEvent.click(screen.getByTestId('user-message-actions'))
    expect(onOpenMessageActions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', messageId: 'msg-m1', canFork: true }),
    )
  })

  it('offers rewind on an anchored user message when the agent supports it', () => {
    renderTimeline([anchoredUser('m1', 'hello', { canFork: false })], 'onlyMessage', {
      rewindAvailable: true,
      onOpenMessageActions: vi.fn(),
    })
    expect(screen.getByTestId('user-message-actions')).toBeTruthy()
  })

  it('hides the user action button when nothing is available', () => {
    renderTimeline([anchoredUser('m1', 'hello', { canFork: false })], 'onlyMessage', {
      onOpenMessageActions: vi.fn(),
    })
    expect(screen.queryByTestId('user-message-actions')).toBeNull()
  })

  it('offers side tasks on finished agent messages only', () => {
    renderTimeline(
      [{ kind: 'message', id: 'a1', role: 'agent', text: 'answer', streaming: false }],
      'onlyMessage',
      {
        sideTaskAvailable: true,
        onOpenMessageActions: vi.fn(),
      },
    )
    expect(screen.getByTestId('agent-message-actions')).toBeTruthy()
  })

  it('hides agent actions while streaming or without text', () => {
    renderTimeline(
      [
        { kind: 'message', id: 'a1', role: 'agent', text: 'partial', streaming: true },
        { kind: 'message', id: 'a2', role: 'agent', text: '   ', streaming: false },
      ],
      'onlyMessage',
      { sideTaskAvailable: true, onOpenMessageActions: vi.fn() },
    )
    expect(screen.queryByTestId('agent-message-actions')).toBeNull()
  })
})
