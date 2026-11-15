import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sessionRouteKey } from '../../state/refs.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import { InboxGroups } from '../InboxGroups.js'

function delivery(overrides: Partial<MobileDeliverySummary> = {}): MobileDeliverySummary {
  return {
    deliveryId: 'd-1',
    phase: 'awaiting_push',
    commitCount: 1,
    dirtySource: false,
    mainBranch: 'main',
    updatedAt: 2_000,
    canConfirmPush: true,
    canRetry: false,
    canUndo: true,
    sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
    ...overrides,
  }
}

function idle(
  localId: string,
  overrides: Partial<MobileSessionSummary> = {},
): MobileSessionSummary {
  return sessionSummary(localId, {
    status: 'idle',
    displayStatus: 'completed',
    bucket: 'completed',
    ...overrides,
  })
}

function rowOf(session: MobileSessionSummary): HTMLElement {
  const row = screen
    .getAllByTestId('inbox-session-row')
    .find((element) => element.dataset.sessionKey === sessionRouteKey(session.ref))
  if (row === undefined) throw new Error(`row ${session.ref.localId} not rendered`)
  return row
}

describe('InboxGroups trigger row', () => {
  it('shows the trigger badge and the verdict summary', () => {
    render(
      <InboxGroups
        sessions={[
          sessionSummary('s1', {
            automation: {
              triggerName: 'Swarm triage',
              verdict: 'escalate',
              summary: 'needs a human',
            },
          }),
        ]}
      />,
    )
    expect(screen.getByText('⚡ Swarm triage')).toBeTruthy()
    expect(screen.getByText('needs a human')).toBeTruthy()
  })

  it('omits the trigger line while the trigger has not reported yet', () => {
    render(
      <InboxGroups
        sessions={[sessionSummary('s1', { automation: { triggerName: 'Swarm triage' } })]}
      />,
    )
    expect(screen.getByText('⚡ Swarm triage')).toBeTruthy()
    expect(screen.queryByText('needs a human')).toBeNull()
  })

  it('omits the trigger line for manual sessions', () => {
    render(<InboxGroups sessions={[sessionSummary('s1')]} />)
    expect(screen.queryByText(/⚡/)).toBeNull()
  })
})

describe('InboxGroups delivery ownership', () => {
  it('renders the delivery action only on the representative row', () => {
    const running = sessionSummary('running', { updatedAt: 1_000 })
    const idleRow = idle('idle', { updatedAt: 5_000, deliveryAvailable: true })
    render(<InboxGroups sessions={[running, idleRow]} />)

    expect(screen.queryByTestId('inbox-delivery-action')).toBeNull()
  })

  it('calls back with the representative session', () => {
    const newest = idle('newest', { updatedAt: 2_000, deliveryAvailable: true })
    const older = idle('older', { updatedAt: 1_000, deliveryAvailable: true })
    const onStartDelivery = vi.fn()
    render(<InboxGroups sessions={[older, newest]} onStartDelivery={onStartDelivery} />)

    const actions = screen.getAllByTestId('inbox-delivery-action')
    expect(actions).toHaveLength(1)
    fireEvent.click(actions[0]!)
    expect(onStartDelivery.mock.calls[0]?.[0]?.ref).toEqual(newest.ref)
  })

  it('keeps the badge on the source row and opens that session', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const source = idle('source', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-2', phase: 'failed' }),
    })
    const onOpenDelivery = vi.fn()
    render(<InboxGroups sessions={[representative, source]} onOpenDelivery={onOpenDelivery} />)

    const badges = screen.getAllByTestId('inbox-delivery-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]!.closest('[data-testid="inbox-session-row"]')).toBe(rowOf(source))
    fireEvent.click(badges[0]!)
    expect(onOpenDelivery.mock.calls[0]?.[0]?.ref).toEqual(source.ref)
  })

  it('shows a badge on each session that owns a record', () => {
    const representative = idle('rep', {
      updatedAt: 3_000,
      delivery: delivery({ deliveryId: 'd-own', phase: 'synced' }),
    })
    const sibling = idle('sib', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-new', updatedAt: 9_000 }),
    })
    const onOpenDelivery = vi.fn()
    render(<InboxGroups sessions={[representative, sibling]} onOpenDelivery={onOpenDelivery} />)

    expect(screen.getAllByTestId('inbox-delivery-badge')).toHaveLength(2)
    fireEvent.click(within(rowOf(representative)).getByTestId('inbox-delivery-badge'))
    expect(onOpenDelivery.mock.calls[0]?.[0]?.ref).toEqual(representative.ref)
  })

  it('shows the starting state on the row that started it', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sib', { updatedAt: 1_000 })
    render(
      <InboxGroups
        sessions={[representative, sibling]}
        isDeliveryStarting={(session) => session.ref.localId === 'sib'}
      />,
    )

    expect(within(rowOf(sibling)).getByTestId('inbox-delivery-starting')).toBeTruthy()
    expect(within(rowOf(representative)).queryByTestId('inbox-delivery-starting')).toBeNull()
  })

  it('replaces the entry with a hint while a sibling delivery holds the lock', () => {
    const representative = idle('rep', { updatedAt: 3_000, deliveryAvailable: true })
    const sibling = idle('sib', { updatedAt: 1_000, delivery: delivery({ phase: 'pushing' }) })
    const onStartDelivery = vi.fn()
    render(<InboxGroups sessions={[representative, sibling]} onStartDelivery={onStartDelivery} />)

    expect(screen.queryByTestId('inbox-delivery-action')).toBeNull()
    const hint = within(rowOf(representative)).getByTestId('inbox-delivery-busy')
    fireEvent.click(hint)
    expect(onStartDelivery).not.toHaveBeenCalled()
  })

  it('keeps windows independent', () => {
    const first = idle('first', {
      ref: sessionRef('first', 1),
      deliveryAvailable: true,
    })
    const second = idle('second', {
      ref: sessionRef('second', 2),
      deliveryAvailable: true,
    })
    render(<InboxGroups sessions={[first, second]} />)

    expect(screen.getAllByTestId('inbox-delivery-action')).toHaveLength(2)
  })
})
