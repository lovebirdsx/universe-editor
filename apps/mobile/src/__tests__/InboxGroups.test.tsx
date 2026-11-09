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
