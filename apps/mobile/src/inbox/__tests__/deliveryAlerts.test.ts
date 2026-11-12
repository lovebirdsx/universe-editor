import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { sessionSummary } from '../../test/protocolFixtures.js'
import { scanDeliveryAlerts } from '../deliveryAlerts.js'

function delivery(overrides: Partial<MobileDeliverySummary> = {}): MobileDeliverySummary {
  return {
    deliveryId: 'd1',
    phase: 'committing',
    commitCount: 0,
    dirtySource: false,
    mainBranch: 'main',
    updatedAt: 1_000,
    canConfirmPush: false,
    canRetry: false,
    canUndo: false,
    sync: { synced: 0, upToDate: 0, skipped: 0, failed: 0 },
    ...overrides,
  }
}

function summary(localId: string, value?: MobileDeliverySummary): MobileSessionSummary {
  return sessionSummary(localId, value === undefined ? {} : { delivery: value })
}

describe('scanDeliveryAlerts', () => {
  it('records the first scan as a baseline without alerts', () => {
    const result = scanDeliveryAlerts(undefined, [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'committing' })),
    ])

    expect(result.next.get('d1')).toBe('committing')
    expect(result.alerts).toEqual([])
  })

  it('alerts when a running delivery reaches awaiting_push', () => {
    const result = scanDeliveryAlerts(new Map([['d1', 'committing']]), [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
    ])

    expect(result.alerts).toEqual([
      { deliveryId: 'd1', phase: 'awaiting_push', sessionTitle: 'Session s1' },
    ])
  })

  it('alerts on failed and partial endings', () => {
    const failed = scanDeliveryAlerts(new Map([['d1', 'pushing']]), [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'failed' })),
    ])
    expect(failed.alerts.map((alert) => alert.phase)).toEqual(['failed'])

    const partial = scanDeliveryAlerts(new Map([['d2', 'awaiting_push']]), [
      summary('s2', delivery({ deliveryId: 'd2', phase: 'partial' })),
    ])
    expect(partial.alerts.map((alert) => alert.phase)).toEqual(['partial'])
  })

  it('ignores active-to-active transitions', () => {
    const result = scanDeliveryAlerts(new Map([['d1', 'committing']]), [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'cherry_picking' })),
    ])

    expect(result.alerts).toEqual([])
  })

  it('does not alert the first time a delivery appears already waiting', () => {
    const result = scanDeliveryAlerts(new Map(), [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
    ])

    expect(result.alerts).toEqual([])
  })

  it('deduplicates the same delivery mirrored on two rows', () => {
    const result = scanDeliveryAlerts(new Map([['d1', 'committing']]), [
      summary('s1', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
      summary('s2', delivery({ deliveryId: 'd1', phase: 'awaiting_push' })),
    ])

    expect(result.next.size).toBe(1)
    expect(result.alerts).toHaveLength(1)
  })
})
