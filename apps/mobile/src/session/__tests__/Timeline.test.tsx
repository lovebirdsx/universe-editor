import type {
  MobileTimelineItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { render, screen } from '@testing-library/react'
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

function userMessage(id: string, text: string): MobileTimelineItem {
  return { kind: 'message', id, role: 'user', text, streaming: false }
}

const client = {
  requestToolCallDetail: vi.fn(),
} as unknown as Pick<MobileClient, 'requestToolCallDetail'>

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
