/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the floating `‹ 2/5 ›` pill: which card the counter names, when the
 *  arrows are enabled, and that clicks route through the widget handle.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Emitter, observableValue } from '@universe-editor/platform'
import type { JSX, MutableRefObject } from 'react'
import type {
  AcpChildItem,
  AcpMessage,
  AcpToolCall,
  TimelineItem,
} from '../../../services/acp/session/acpSession.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'
import type { WidgetHandle } from '../ChatBody.js'
import { SubagentNavBar } from '../SubagentNavBar.js'

function message(id: string): TimelineItem {
  const value: AcpMessage = { id, role: 'agent', text: id, blocks: [], streaming: false }
  return { kind: 'message', id, message: value }
}

function call(id: string, overrides: Partial<AcpToolCall> = {}): AcpToolCall {
  return {
    id,
    title: id,
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function subagent(id: string, children: readonly AcpChildItem[] = []): TimelineItem {
  return { kind: 'toolCall', id, call: call(id, { subagent: true, children }) }
}

function makeSession(timeline: readonly TimelineItem[]): IAcpSession {
  return { id: 's1', timeline: observableValue('timeline', timeline) } as unknown as IAcpSession
}

function makeHandle(focusedKey: string | null): {
  handle: WidgetHandle
  moveSubagent: ReturnType<typeof vi.fn>
  fireFocusChange: () => void
} {
  const focusEmitter = new Emitter<void>()
  const collapseEmitter = new Emitter<void>()
  const moveSubagent = vi.fn()
  const handle = {
    moveSubagent,
    getFocusedKey: () => focusedKey,
    onDidChangeFocusedKey: focusEmitter.event,
    onDidChangeCollapse: collapseEmitter.event,
  } as unknown as WidgetHandle
  return { handle, moveSubagent, fireFocusChange: () => focusEmitter.fire() }
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function stubRect(el: Element, top: number, bottom: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(top, bottom))
}

const SCROLL_HEIGHT = 100

function Harness({
  timeline,
  handle,
}: {
  timeline: readonly TimelineItem[]
  handle: WidgetHandle
}): JSX.Element {
  const scrollContainerRef: MutableRefObject<HTMLDivElement | null> = { current: null }
  return (
    <div>
      <SubagentNavBar
        session={makeSession(timeline)}
        scrollContainerRef={scrollContainerRef}
        handleRef={{ current: handle }}
      />
      <div
        data-testid="scroll"
        ref={(el) => {
          scrollContainerRef.current = el
          if (el) stubRect(el, 0, SCROLL_HEIGHT)
        }}
      >
        {timeline.map((item, index) => (
          <div
            key={item.id}
            data-timeline-key={`t:${item.id}`}
            ref={(el) => {
              if (el) stubRect(el, index * 40, index * 40 + 30)
            }}
          />
        ))}
      </div>
    </div>
  )
}

let rafCallbacks: FrameRequestCallback[] = []

function flushRaf(): void {
  const pending = rafCallbacks
  rafCallbacks = []
  for (const callback of pending) callback(0)
}

/** Render + drain the initial rAF-throttled recompute. */
function renderBar(timeline: readonly TimelineItem[], handle: WidgetHandle): void {
  render(<Harness timeline={timeline} handle={handle} />)
  act(() => flushRaf())
}

beforeEach(() => {
  // Capture rAF callbacks so the pill's throttle can be flushed deterministically
  // (calling them synchronously inside the mock would race the returned id).
  rafCallbacks = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SubagentNavBar', () => {
  it('renders nothing when the timeline has no sub-agent cards', () => {
    const { handle } = makeHandle(null)
    renderBar([message('m0'), { kind: 'toolCall', id: 'plain', call: call('plain') }], handle)
    expect(screen.queryByTestId('acp-subagent-nav')).toBeNull()
  })

  it('counts the card at the viewport top and walks forward', () => {
    const { handle, moveSubagent } = makeHandle(null)
    renderBar([subagent('g0'), subagent('g1')], handle)

    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('1/2')
    expect((screen.getByTestId('acp-subagent-prev') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('acp-subagent-next') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('acp-subagent-next'))
    expect(moveSubagent).toHaveBeenCalledWith('next')
  })

  it('prefers the focused card while it is still on screen', () => {
    const { handle, moveSubagent } = makeHandle('t:g1')
    renderBar([subagent('g0'), subagent('g1')], handle)

    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('2/2')
    expect((screen.getByTestId('acp-subagent-prev') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('acp-subagent-next') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('acp-subagent-prev'))
    expect(moveSubagent).toHaveBeenCalledWith('prev')
  })

  it('shows an unknown position with both arrows enabled above every card', () => {
    const { handle, moveSubagent } = makeHandle(null)
    renderBar([subagent('g0'), subagent('g1')], handle)

    const scroll = screen.getByTestId('scroll')
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(1000, 1100))
    fireEvent.scroll(scroll)
    act(() => flushRaf())

    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('–/2')
    const prev = screen.getByTestId('acp-subagent-prev') as HTMLButtonElement
    const next = screen.getByTestId('acp-subagent-next') as HTMLButtonElement
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(false)
    fireEvent.click(prev)
    expect(moveSubagent).toHaveBeenCalledWith('prev')
  })

  it('falls back to the viewport position when focus scrolled out of view', () => {
    const { handle } = makeHandle('t:g0')
    renderBar([subagent('g0'), subagent('g1')], handle)
    // g0 is on screen at mount, so move it out of view and let the listener run.
    const scroll = screen.getByTestId('scroll')
    vi.spyOn(scroll.firstElementChild as Element, 'getBoundingClientRect').mockReturnValue(
      rect(-80, -50),
    )
    fireEvent.scroll(scroll)
    act(() => flushRaf())

    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('2/2')
  })

  it('updates the counter when the scroll lands on another card', () => {
    const { handle } = makeHandle(null)
    renderBar([subagent('g0'), subagent('g1'), subagent('g2')], handle)
    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('1/3')

    const scroll = screen.getByTestId('scroll')
    const slots = scroll.children
    vi.spyOn(slots[0] as Element, 'getBoundingClientRect').mockReturnValue(rect(-90, -60))
    vi.spyOn(slots[1] as Element, 'getBoundingClientRect').mockReturnValue(rect(-30, 0))
    vi.spyOn(slots[2] as Element, 'getBoundingClientRect').mockReturnValue(rect(40, 70))
    fireEvent.scroll(scroll)
    act(() => flushRaf())

    expect(screen.getByTestId('acp-subagent-count').textContent).toBe('3/3')
  })
})
