import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
import {
  deliveryTone,
  isActiveDeliveryPhase,
  selectDeliveryEntries,
  summarizeDeliveries,
} from '../deliveryStatus.js'

function delivery(overrides: Partial<MobileDeliverySummary> = {}): MobileDeliverySummary {
  return {
    deliveryId: 'd1',
    phase: 'awaiting_push',
    commitCount: 1,
    dirtySource: false,
    mainBranch: 'main',
    updatedAt: 1_000,
    canConfirmPush: true,
    canRetry: false,
    canUndo: true,
    sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
    ...overrides,
  }
}

function summary(localId: string, value?: MobileDeliverySummary): MobileSessionSummary {
  return sessionSummary(localId, value === undefined ? {} : { delivery: value })
}

describe('deliveryStatus', () => {
  it('selects one entry per delivery id and filters finished phases', () => {
    const entries = selectDeliveryEntries([
      summary('s1', delivery({ deliveryId: 'd1', phase: 'synced' })),
      summary('s2', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
      summary('s3', delivery({ deliveryId: 'd2', phase: 'cherry_picking' })),
      summary('s4', delivery({ deliveryId: 'd3', phase: 'failed' })),
      summary('s5'),
    ])

    expect(entries.map((entry) => entry.delivery.deliveryId)).toEqual(['d1', 'd2', 'd3'])
    expect(
      selectDeliveryEntries(
        [
          summary('s1', delivery({ deliveryId: 'd1', phase: 'synced' })),
          summary('s2', delivery({ deliveryId: 'd2', phase: 'failed' })),
        ],
        true,
      ).map((entry) => entry.delivery.deliveryId),
    ).toEqual(['d2'])
  })

  it('counts active, pushable and failed deliveries for the summary bar', () => {
    const entries = selectDeliveryEntries([
      summary('s1', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
      summary('s2', delivery({ deliveryId: 'd2', phase: 'pushing' })),
      summary('s3', delivery({ deliveryId: 'd3', phase: 'failed' })),
      summary('s4', delivery({ deliveryId: 'd4', phase: 'partial' })),
    ])

    expect(summarizeDeliveries(entries)).toEqual({
      total: 4,
      active: 1,
      activePhase: 'pushing',
      pushable: 1,
      failed: 2,
    })
  })

  it('keeps the first active phase when several deliveries run', () => {
    const entries = selectDeliveryEntries([
      summary('s1', delivery({ deliveryId: 'd1', phase: 'committing' })),
      summary('s2', delivery({ deliveryId: 'd2', phase: 'cherry_picking' })),
    ])

    expect(summarizeDeliveries(entries)).toMatchObject({
      total: 2,
      active: 2,
      activePhase: 'committing',
    })
  })

  it('classifies phases for activity and badge tone', () => {
    expect(isActiveDeliveryPhase('syncing')).toBe(true)
    expect(isActiveDeliveryPhase('awaiting_push')).toBe(false)
    expect(deliveryTone('awaiting_push')).toBe('action')
    expect(deliveryTone('failed')).toBe('danger')
    expect(deliveryTone('synced')).toBe('ok')
    expect(deliveryTone('preflighting')).toBe('active')
  })
})
