import type { MobileDeliverySummary, MobileSessionSummary } from '@universe-editor/mobile-protocol'
import { describe, expect, it } from 'vitest'
import { localRefKey } from '../../state/refs.js'
import { sessionRef, sessionSummary } from '../../test/protocolFixtures.js'
import { selectInboxDeliveryRows } from '../deliveryOwnership.js'

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

function rowFor(
  sessions: readonly MobileSessionSummary[],
  target: MobileSessionSummary,
  isStarting?: (session: MobileSessionSummary) => boolean,
) {
  return selectInboxDeliveryRows(sessions, isStarting).get(localRefKey(target.ref))
}

const startable = { canStart: true, busyInWorkspace: false }

describe('selectInboxDeliveryRows', () => {
  it('returns an empty map without sessions', () => {
    expect(selectInboxDeliveryRows([]).size).toBe(0)
  })

  it('offers the start entry on a single row with pending work', () => {
    const only = idle('only', { deliveryAvailable: true })
    expect(rowFor([only], only)).toEqual(startable)
  })

  it('omits rows without pending work or a record', () => {
    const only = idle('only')
    expect(selectInboxDeliveryRows([only]).size).toBe(0)
  })

  it('keeps the entry off a running representative', () => {
    const running = sessionSummary('running', { updatedAt: 1_000 })
    const idleNewest = idle('idle', { updatedAt: 5_000, deliveryAvailable: true })
    const map = selectInboxDeliveryRows([running, idleNewest])
    expect(map.size).toBe(0)
  })

  it('offers the entry only on the most recently updated row', () => {
    const older = idle('older', { updatedAt: 1_000, deliveryAvailable: true })
    const newer = idle('newer', { updatedAt: 2_000, deliveryAvailable: true })
    const map = selectInboxDeliveryRows([older, newer])
    expect(map.get(localRefKey(newer.ref))).toEqual(startable)
    expect(map.has(localRefKey(older.ref))).toBe(false)
  })

  it('breaks updatedAt ties by localId so the representative is deterministic', () => {
    const alpha = idle('alpha', { updatedAt: 1_000, deliveryAvailable: true })
    const bravo = idle('bravo', { updatedAt: 1_000, deliveryAvailable: true })
    const map = selectInboxDeliveryRows([bravo, alpha])
    expect(map.has(localRefKey(alpha.ref))).toBe(true)
    expect(map.has(localRefKey(bravo.ref))).toBe(false)
  })

  it('keeps windows independent', () => {
    const first = idle('first', { ref: sessionRef('first', 1), deliveryAvailable: true })
    const second = idle('second', { ref: sessionRef('second', 2), deliveryAvailable: true })
    const map = selectInboxDeliveryRows([first, second])
    expect(map.get(localRefKey(first.ref))).toEqual(startable)
    expect(map.get(localRefKey(second.ref))).toEqual(startable)
  })

  it('never moves another session availability onto the representative', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const sibling = idle('sibling', { updatedAt: 1_000, deliveryAvailable: true })
    expect(selectInboxDeliveryRows([representative, sibling]).size).toBe(0)
  })

  it('keeps a record on its own session instead of the representative', () => {
    const representative = idle('rep', { updatedAt: 3_000 })
    const source = idle('source', {
      updatedAt: 1_000,
      delivery: delivery({ deliveryId: 'd-fail', phase: 'failed' }),
    })
    const map = selectInboxDeliveryRows([representative, source])
    expect(map.has(localRefKey(representative.ref))).toBe(false)
    expect(map.get(localRefKey(source.ref))?.delivery?.deliveryId).toBe('d-fail')
  })

  it('gives every session its own record', () => {
    const alpha = idle('alpha', { delivery: delivery({ deliveryId: 'd-a' }) })
    const bravo = idle('bravo', { delivery: delivery({ deliveryId: 'd-b' }) })
    const map = selectInboxDeliveryRows([alpha, bravo])
    expect(map.get(localRefKey(alpha.ref))?.delivery?.deliveryId).toBe('d-a')
    expect(map.get(localRefKey(bravo.ref))?.delivery?.deliveryId).toBe('d-b')
  })

  it('shows a mirrored delivery id on the first row only', () => {
    const alpha = idle('alpha', { delivery: delivery({ deliveryId: 'd-1' }) })
    const bravo = idle('bravo', { delivery: delivery({ deliveryId: 'd-1' }) })
    const map = selectInboxDeliveryRows([bravo, alpha])
    expect(map.get(localRefKey(bravo.ref))?.delivery?.deliveryId).toBe('d-1')
    expect(map.has(localRefKey(alpha.ref))).toBe(false)
  })

  it('does not offer a start entry on a row that already has a record', () => {
    const representative = idle('rep', {
      deliveryAvailable: true,
      delivery: delivery({ phase: 'synced' }),
    })
    expect(rowFor([representative], representative)).toMatchObject({
      canStart: false,
      busyInWorkspace: false,
    })
  })

  it.each(['committing', 'awaiting_push', 'resolving_conflict'] as const)(
    'marks the representative busy while a sibling delivery is %s',
    (phase) => {
      const representative = idle('rep', { updatedAt: 3_000, deliveryAvailable: true })
      const sibling = idle('sibling', { updatedAt: 1_000, delivery: delivery({ phase }) })
      expect(rowFor([representative, sibling], representative)).toEqual({
        canStart: false,
        busyInWorkspace: true,
      })
    },
  )

  it.each(['failed', 'partial', 'synced', 'undone'] as const)(
    'keeps the entry when the sibling delivery is %s',
    (phase) => {
      const representative = idle('rep', { updatedAt: 3_000, deliveryAvailable: true })
      const sibling = idle('sibling', { updatedAt: 1_000, delivery: delivery({ phase }) })
      expect(rowFor([representative, sibling], representative)).toEqual(startable)
    },
  )

  it('marks the representative busy while a sibling start is in flight', () => {
    const representative = idle('rep', { updatedAt: 3_000, deliveryAvailable: true })
    const sibling = idle('sibling', { updatedAt: 1_000 })
    const row = rowFor([representative, sibling], representative, (s) => s === sibling)
    expect(row).toEqual({ canStart: false, busyInWorkspace: true })
  })

  it('ignores busy siblings in another window', () => {
    const representative = idle('rep', { ref: sessionRef('rep', 1), deliveryAvailable: true })
    const other = idle('other', {
      ref: sessionRef('other', 2),
      delivery: delivery({ phase: 'pushing' }),
    })
    expect(rowFor([representative, other], representative)).toEqual(startable)
  })
})
