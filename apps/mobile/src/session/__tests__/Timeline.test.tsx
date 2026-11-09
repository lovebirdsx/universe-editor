import type {
  MobileTimelineItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { render, screen, waitFor } from '@testing-library/react'
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
}
const client = clientMock as unknown as Pick<
  MobileClient,
  'requestToolCallDetail' | 'fetchAttachmentBlob'
>

function renderTimeline(
  timeline: readonly MobileTimelineItem[],
  displayMode: 'onlyMessage' | 'full',
): void {
  render(
    <Timeline
      sessionKey="1:s1"
      timeline={timeline}
      displayMode={displayMode}
      truncated={false}
      client={client}
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
