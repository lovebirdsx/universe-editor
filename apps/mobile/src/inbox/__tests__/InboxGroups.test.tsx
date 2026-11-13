import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

  it('borrows the newest sibling delivery badge and opens its source session', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const source = idle('source', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-2' }),
    })
    const onOpenDelivery = vi.fn()
    render(<InboxGroups sessions={[representative, source]} onOpenDelivery={onOpenDelivery} />)

    expect(screen.getAllByTestId('inbox-delivery-badge')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('inbox-delivery-badge'))
    expect(onOpenDelivery.mock.calls[0]?.[0]?.ref).toEqual(source.ref)
  })

  it('keeps its own delivery record ahead of a newer sibling record', () => {
    const representative = idle('rep', {
      updatedAt: 3_000,
      delivery: delivery({ deliveryId: 'd-own', updatedAt: 1_000 }),
    })
    const sibling = idle('sib', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-new', updatedAt: 9_000 }),
    })
    const onOpenDelivery = vi.fn()
    render(<InboxGroups sessions={[representative, sibling]} onOpenDelivery={onOpenDelivery} />)

    fireEvent.click(screen.getByTestId('inbox-delivery-badge'))
    expect(onOpenDelivery.mock.calls[0]?.[0]?.ref).toEqual(representative.ref)
  })

  it('hides the starting state on non-representative rows', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sib', { updatedAt: 1_000 })
    render(
      <InboxGroups
        sessions={[representative, sibling]}
        isDeliveryStarting={(session) => session.ref.localId === 'sib'}
      />,
    )

    expect(screen.queryByTestId('inbox-delivery-starting')).toBeNull()
  })

  it('shows the starting state on the representative row', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sib', { updatedAt: 1_000 })
    render(
      <InboxGroups
        sessions={[representative, sibling]}
        isDeliveryStarting={(session) => session.ref.localId === 'rep'}
      />,
    )

    expect(screen.getByTestId('inbox-delivery-starting')).toBeTruthy()
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
