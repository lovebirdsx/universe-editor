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
): MobileSessionSummary {
  return {
    ref: { windowId: 1, localId },
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

describe('InboxGroups', () => {
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
