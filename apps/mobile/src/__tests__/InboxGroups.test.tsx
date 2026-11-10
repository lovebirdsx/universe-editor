import type { MobileSessionBucket, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { groupSessions, selectInboxSessions } from '../inbox/groupSessions.js'
import { InboxGroups } from '../inbox/InboxGroups.js'
import { strings } from '../strings.js'

function session(
  localId: string,
  bucket: MobileSessionBucket,
  title: string,
  windowId = 1,
): MobileSessionSummary {
  return {
    ref: { windowId, localId },
    agentId: 'claude',
    title,
    status: 'running',
    displayStatus: bucket === 'in_progress' ? 'working' : bucket,
    bucket,
    workspaceName: 'demo-workspace',
    readOnly: false,
    hasPendingPermission: false,
    hasPendingElicitation: false,
    backgroundTaskCount: 0,
    updatedAt: Date.now(),
  }
}

function visibleTitles(): string[] {
  return screen
    .getAllByTestId('inbox-session-row')
    .map((row) => row.querySelector('.session-card__title')?.textContent ?? '')
}

function groupHeadings(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent ?? '')
}

function actionsOpen(title: string): boolean {
  const swipeRow = screen.getByText(title).closest('[data-testid="inbox-swipe-row"]')
  const action = swipeRow?.querySelector('[data-testid="inbox-session-close-action"]')
  return action?.getAttribute('tabindex') === '0'
}

function firePointerAt(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: PointerEventInit,
  timeStamp: number,
): void {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'timeStamp', { configurable: true, value: timeStamp })
  fireEvent(element, event)
}

function dispatchTouch(
  element: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  touches: readonly { readonly clientX: number; readonly clientY: number }[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: touches })
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}

describe('InboxGroups', () => {
  it('marks rows whose workspace has uncommitted changes', () => {
    render(
      <InboxGroups
        sessions={[session('dirty', 'completed', 'Changed task')]}
        dirtyWindowIds={new Set([1])}
      />,
    )

    expect(screen.getByText(strings.badgeWorkspaceDirty)).toBeTruthy()
  })

  it('does not mark rows for clean or unknown windows', () => {
    render(
      <InboxGroups
        sessions={[session('clean', 'completed', 'Clean task')]}
        dirtyWindowIds={new Set([2])}
      />,
    )

    expect(screen.queryByText(strings.badgeWorkspaceDirty)).toBeNull()
  })

  it('orders buckets by urgency and renders each session', () => {
    render(
      <InboxGroups
        sessions={[
          session('done', 'completed', 'Finished task'),
          session('failed', 'failed', 'Broken task'),
          session('running', 'in_progress', 'Running task'),
          session('ask', 'input_needed', 'Needs approval'),
        ]}
      />,
    )

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings).toEqual([
      `${strings.bucketInputNeeded}1`,
      `${strings.bucketInProgress}1`,
      `${strings.bucketFailed}1`,
      `${strings.bucketCompleted}1`,
    ])
    expect(screen.getByText('Needs approval')).toBeTruthy()
    expect(screen.getByText('Broken task')).toBeTruthy()
    expect(screen.getByText('Running task')).toBeTruthy()
    expect(screen.getByText('Finished task')).toBeTruthy()
  })

  it('omits empty buckets', () => {
    render(<InboxGroups sessions={[session('ask', 'input_needed', 'Needs approval')]} />)
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings).toEqual([`${strings.bucketInputNeeded}1`])
  })

  it('renders nothing for an empty inbox', () => {
    const { container } = render(<InboxGroups sessions={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('groupSessions returns no groups for an empty list', () => {
    expect(groupSessions([])).toEqual([])
  })

  it('filters side-task mirrors out of the inbox list', () => {
    const parent = session('parent', 'completed', 'Parent')
    const side = { ...session('side', 'completed', 'Side'), sideTaskOf: 'durable-parent' }
    expect(selectInboxSessions([parent, side])).toEqual([parent])
    expect(selectInboxSessions([side])).toEqual([])
  })

  it('reveals close/remove after a horizontal swipe', () => {
    const onCloseSession = vi.fn()
    const onRemoveSession = vi.fn()
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onCloseSession={onCloseSession}
        onRemoveSession={onRemoveSession}
      />,
    )

    const row = screen.getByTestId('inbox-session-row')
    fireEvent.pointerDown(row, { clientX: 240, clientY: 20, button: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: 100, clientY: 22, pointerId: 1 })
    fireEvent.pointerUp(row, { clientX: 100, clientY: 22, pointerId: 1 })

    fireEvent.click(screen.getByTestId('inbox-session-close-action'))
    expect(onCloseSession).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('inbox-session-remove-action'))
    expect(onRemoveSession).toHaveBeenCalledTimes(1)
  })

  it('uses release velocity to complete a short fast flick', () => {
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onCloseSession={vi.fn()}
      />,
    )

    const row = screen.getByTestId('inbox-session-row')
    firePointerAt(row, 'pointerdown', { clientX: 200, clientY: 20, button: 0, pointerId: 1 }, 1000)
    firePointerAt(row, 'pointermove', { clientX: 160, clientY: 22, pointerId: 1 }, 1016)
    // 50px is below the 76px position threshold, but the release speed projects
    // the row past it.
    firePointerAt(row, 'pointerup', { clientX: 150, clientY: 22, pointerId: 1 }, 1032)

    expect(actionsOpen('Running task')).toBe(true)
  })

  it('does not project a short slow drag that ends at rest', () => {
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onCloseSession={vi.fn()}
      />,
    )

    const row = screen.getByTestId('inbox-session-row')
    firePointerAt(row, 'pointerdown', { clientX: 200, clientY: 20, button: 0, pointerId: 1 }, 1000)
    firePointerAt(row, 'pointermove', { clientX: 160, clientY: 22, pointerId: 1 }, 1100)
    firePointerAt(row, 'pointerup', { clientX: 150, clientY: 22, pointerId: 1 }, 1300)

    expect(actionsOpen('Running task')).toBe(false)
  })

  it('claims diagonal touch moves from the browser pan', () => {
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onCloseSession={vi.fn()}
      />,
    )

    const track = screen
      .getByTestId('inbox-swipe-row')
      .querySelector<HTMLElement>('.inbox-swipe-row__track')
    expect(track).not.toBeNull()
    dispatchTouch(track!, 'touchstart', [{ clientX: 200, clientY: 100 }])
    // Thumb arc: 45px down for 30px left must still belong to the swipe.
    const diagonal = dispatchTouch(track!, 'touchmove', [{ clientX: 170, clientY: 145 }])
    expect(diagonal.defaultPrevented).toBe(true)
    dispatchTouch(track!, 'touchend', [])
    dispatchTouch(track!, 'touchstart', [{ clientX: 200, clientY: 100 }])
    const vertical = dispatchTouch(track!, 'touchmove', [{ clientX: 198, clientY: 160 }])
    expect(vertical.defaultPrevented).toBe(false)
  })

  it('ignores a second touch pointer during a swipe', () => {
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onCloseSession={vi.fn()}
      />,
    )

    const row = screen.getByTestId('inbox-session-row')
    fireEvent.pointerDown(row, {
      clientX: 240,
      clientY: 20,
      button: 0,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    })
    fireEvent.pointerMove(row, {
      clientX: 140,
      clientY: 22,
      pointerId: 1,
      pointerType: 'touch',
    })
    fireEvent.pointerDown(row, {
      clientX: 300,
      clientY: 60,
      button: 0,
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: false,
    })
    fireEvent.pointerMove(row, {
      clientX: 280,
      clientY: 60,
      pointerId: 2,
      pointerType: 'touch',
    })
    fireEvent.pointerUp(row, {
      clientX: 140,
      clientY: 22,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    })

    expect(actionsOpen('Running task')).toBe(true)
  })

  it('keeps the actions revealed when the post-swipe click arrives late', () => {
    vi.useFakeTimers()
    try {
      render(
        <InboxGroups
          sessions={[session('running', 'in_progress', 'Running task')]}
          onCloseSession={vi.fn()}
          onRemoveSession={vi.fn()}
        />,
      )

      const row = screen.getByTestId('inbox-session-row')
      fireEvent.pointerDown(row, { clientX: 240, clientY: 20, button: 0, pointerId: 1 })
      fireEvent.pointerMove(row, { clientX: 60, clientY: 22, pointerId: 1 })
      fireEvent.pointerUp(row, { clientX: 60, clientY: 22, pointerId: 1 })

      // Mobile browsers dispatch the compatibility click in a later task, which
      // can land after the zero-delay reset and must not close the open row.
      act(() => {
        vi.advanceTimersByTime(0)
      })
      fireEvent.click(row)

      expect(screen.getByTestId('inbox-session-close-action').getAttribute('tabindex')).toBe('0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the list still while a row is being swiped', () => {
    const alpha = session('alpha', 'in_progress', 'Alpha')
    const bravo = { ...session('bravo', 'in_progress', 'Bravo'), updatedAt: alpha.updatedAt - 1000 }
    const props = { onCloseSession: vi.fn(), onRemoveSession: vi.fn() }
    const { rerender } = render(<InboxGroups sessions={[alpha, bravo]} {...props} />)

    const row = screen.getAllByTestId('inbox-session-row')[0]!
    fireEvent.pointerDown(row, { clientX: 240, clientY: 20, button: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: 120, clientY: 22, pointerId: 1 })

    // Another session becoming the most recent must not move rows mid-gesture.
    rerender(
      <InboxGroups
        sessions={[{ ...bravo, updatedAt: alpha.updatedAt + 1000 }, alpha]}
        {...props}
      />,
    )
    expect(visibleTitles()).toEqual(['Alpha', 'Bravo'])

    fireEvent.pointerUp(row, { clientX: 120, clientY: 22, pointerId: 1 })
    expect(visibleTitles()).toEqual(['Bravo', 'Alpha'])
    expect(actionsOpen('Alpha')).toBe(true)
  })

  it('holds a swiped row in place when its bucket changes mid-gesture', () => {
    const alpha = session('alpha', 'in_progress', 'Alpha')
    const completed = {
      ...alpha,
      status: 'idle',
      displayStatus: 'completed',
      bucket: 'completed' as const,
    }
    const props = { onCloseSession: vi.fn(), onRemoveSession: vi.fn() }
    const { rerender } = render(<InboxGroups sessions={[alpha]} {...props} />)

    const row = screen.getByTestId('inbox-session-row')
    fireEvent.pointerDown(row, { clientX: 240, clientY: 20, button: 0, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: 120, clientY: 22, pointerId: 1 })

    rerender(<InboxGroups sessions={[completed]} {...props} />)
    expect(groupHeadings()).toEqual([`${strings.bucketInProgress}1`])

    fireEvent.pointerUp(row, { clientX: 120, clientY: 22, pointerId: 1 })
    expect(groupHeadings()).toEqual([`${strings.bucketCompleted}1`])
    expect(actionsOpen('Alpha')).toBe(true)
  })

  it('opens the action menu on a long press', () => {
    vi.useFakeTimers()
    try {
      const onShowSessionActions = vi.fn()
      render(
        <InboxGroups
          sessions={[session('running', 'in_progress', 'Running task')]}
          onShowSessionActions={onShowSessionActions}
        />,
      )

      const row = screen.getByTestId('inbox-session-row')
      fireEvent.pointerDown(row, { clientX: 100, clientY: 20, button: 0, pointerId: 1 })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      fireEvent.pointerUp(row, { clientX: 100, clientY: 20, pointerId: 1 })

      expect(onShowSessionActions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not swallow the next tap after a long press ends off-track', () => {
    vi.useFakeTimers()
    try {
      const onShowSessionActions = vi.fn()
      const onOpenSession = vi.fn()
      render(
        <InboxGroups
          sessions={[session('running', 'in_progress', 'Running task')]}
          onOpenSession={onOpenSession}
          onShowSessionActions={onShowSessionActions}
        />,
      )

      const row = screen.getByTestId('inbox-session-row')
      fireEvent.pointerDown(row, { clientX: 100, clientY: 20, button: 0, pointerId: 1 })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(onShowSessionActions).toHaveBeenCalledTimes(1)
      // The pointerup that follows a mouse long-press lands on the sheet
      // overlay, so the row never sees it.
      fireEvent.pointerDown(row, { clientX: 100, clientY: 20, button: 0, pointerId: 1 })
      fireEvent.pointerUp(row, { clientX: 100, clientY: 20, button: 0, pointerId: 1 })
      fireEvent.click(row)

      expect(onOpenSession).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers the action menu through the context-menu key', () => {
    const onShowSessionActions = vi.fn()
    render(
      <InboxGroups
        sessions={[session('running', 'in_progress', 'Running task')]}
        onShowSessionActions={onShowSessionActions}
      />,
    )

    const row = screen.getByTestId('inbox-session-row')
    expect(row.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.contextMenu(row)
    expect(onShowSessionActions).toHaveBeenCalledTimes(1)
  })

  it('does not wrap read-only sessions in swipe actions', () => {
    render(
      <InboxGroups
        sessions={[session('preview', 'completed', 'Preview')].map((entry) => ({
          ...entry,
          readOnly: true,
        }))}
        onCloseSession={vi.fn()}
        onRemoveSession={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('inbox-swipe-row')).toBeNull()
    expect(screen.getByTestId('inbox-session-row')).toBeTruthy()
  })
})
