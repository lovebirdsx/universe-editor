import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { localRefKey } from '../../state/refs.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import { selectInboxDeliveryOwnership } from '../deliveryOwnership.js'

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

function ownershipFor(sessions: readonly MobileSessionSummary[], target: MobileSessionSummary) {
  return selectInboxDeliveryOwnership(sessions).get(localRefKey(target.ref))
}

describe('selectInboxDeliveryOwnership', () => {
  it('returns an empty map without sessions', () => {
    expect(selectInboxDeliveryOwnership([]).size).toBe(0)
  })

  it('owns the delivery UI on a single row from its own fields', () => {
    const only = idle('only', { deliveryAvailable: true })
    const map = selectInboxDeliveryOwnership([only])
    expect(map.size).toBe(1)
    expect(map.get(localRefKey(only.ref))).toEqual({ available: true })
  })

  it('prefers a running session over a more recent idle one', () => {
    const running = sessionSummary('running', { updatedAt: 1_000 })
    const idleNewest = idle('idle', { updatedAt: 5_000, deliveryAvailable: true })
    const map = selectInboxDeliveryOwnership([running, idleNewest])
    expect(map.has(localRefKey(running.ref))).toBe(true)
    expect(map.get(localRefKey(running.ref))?.available).toBe(false)
    expect(map.has(localRefKey(idleNewest.ref))).toBe(false)
  })

  it('picks the most recently updated running session', () => {
    const older = sessionSummary('older', { updatedAt: 1_000 })
    const newer = sessionSummary('newer', { updatedAt: 2_000 })
    const map = selectInboxDeliveryOwnership([older, newer])
    expect(map.has(localRefKey(newer.ref))).toBe(true)
    expect(map.has(localRefKey(older.ref))).toBe(false)
  })

  it('breaks updatedAt ties by localId so the representative is deterministic', () => {
    const alpha = idle('alpha', { updatedAt: 1_000 })
    const bravo = idle('bravo', { updatedAt: 1_000 })
    const map = selectInboxDeliveryOwnership([bravo, alpha])
    expect(map.has(localRefKey(alpha.ref))).toBe(true)
    expect(map.has(localRefKey(bravo.ref))).toBe(false)
  })

  it('falls back to the most recent session when nothing is running', () => {
    const older = idle('older', { updatedAt: 1_000 })
    const newer = idle('newer', { updatedAt: 2_000 })
    const map = selectInboxDeliveryOwnership([older, newer])
    expect(map.has(localRefKey(newer.ref))).toBe(true)
    expect(map.has(localRefKey(older.ref))).toBe(false)
  })

  it('keeps windows independent', () => {
    const first = idle('first', { ref: sessionRef('first', 1), deliveryAvailable: true })
    const second = idle('second', { ref: sessionRef('second', 2), deliveryAvailable: true })
    const map = selectInboxDeliveryOwnership([first, second])
    expect(map.get(localRefKey(first.ref))).toEqual({ available: true })
    expect(map.get(localRefKey(second.ref))).toEqual({ available: true })
  })

  it('never moves another session availability onto the representative', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sibling', { updatedAt: 1_000, deliveryAvailable: true })
    const map = selectInboxDeliveryOwnership([representative, sibling])
    expect(map.get(localRefKey(representative.ref))).toEqual({ available: false })
    expect(map.has(localRefKey(sibling.ref))).toBe(false)
  })

  it("prefers the representative's own record", () => {
    const representative = idle('rep', {
      updatedAt: 3_000,
      delivery: delivery({ deliveryId: 'd-own', updatedAt: 1_000 }),
    })
    const sibling = idle('sibling', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-new', updatedAt: 9_000 }),
    })
    const own = ownershipFor([representative, sibling], representative)
    expect(own?.delivery?.deliveryId).toBe('d-own')
    expect(own?.deliverySource).toBe(representative)
  })

  it('borrows the newest delivery from the same window', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const olderSource = idle('older', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-old', updatedAt: 1_000 }),
    })
    const newerSource = idle('newer', {
      updatedAt: 500,
      delivery: delivery({ deliveryId: 'd-new', updatedAt: 5_000 }),
    })
    const shared = ownershipFor([representative, olderSource, newerSource], representative)
    expect(shared?.delivery?.deliveryId).toBe('d-new')
    expect(shared?.deliverySource).toBe(newerSource)
  })

  it('breaks borrowed delivery ties by session key', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const alpha = idle('alpha', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-alpha', updatedAt: 5_000 }),
    })
    const bravo = idle('bravo', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-bravo', updatedAt: 5_000 }),
    })
    const shared = ownershipFor([representative, bravo, alpha], representative)
    expect(shared?.deliverySource).toBe(alpha)
  })

  it('omits the record fields when the window has none', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sibling', { updatedAt: 1_000 })
    const own = ownershipFor([representative, sibling], representative)
    expect(own).toEqual({ available: false })
  })

  it('resolves a mirrored delivery id to one deterministic owner', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const alpha = idle('alpha', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-1', updatedAt: 5_000 }),
    })
    const bravo = idle('bravo', {
      updatedAt: 900,
      delivery: delivery({ deliveryId: 'd-1', updatedAt: 5_000 }),
    })
    const shared = ownershipFor([representative, bravo, alpha], representative)
    expect(shared?.delivery?.deliveryId).toBe('d-1')
    expect(shared?.deliverySource).toBe(alpha)
  })
})
