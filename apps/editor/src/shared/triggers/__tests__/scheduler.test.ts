import { describe, expect, it } from 'vitest'
import { computeDue, DEFAULT_MISSED_GRACE_MS, type ScheduleSourceConfig } from '../scheduler.js'

const MINUTE = 60_000

const every = (
  everyMin: number,
  onMissed: ScheduleSourceConfig['onMissed'] = 'skip',
): ScheduleSourceConfig => ({ type: 'schedule', everyMin, onMissed })

const cron = (
  expression: string,
  onMissed: ScheduleSourceConfig['onMissed'] = 'skip',
): ScheduleSourceConfig => ({ type: 'schedule', cron: expression, onMissed })

describe('computeDue (first enable)', () => {
  it('does not catch up and only reports the next run', () => {
    const now = 1_000_000
    expect(computeDue(every(5), undefined, now)).toEqual({
      due: [],
      next: now + 5 * MINUTE,
      skipped: 0,
    })
    const localNow = new Date(2026, 2, 2, 12, 0, 0, 0).getTime()
    expect(computeDue(cron('0 9 * * *'), undefined, localNow)).toEqual({
      due: [],
      next: new Date(2026, 2, 3, 9, 0, 0, 0).getTime(),
      skipped: 0,
    })
  })
})

describe('computeDue (everyMin)', () => {
  const anchor = 10_000_000

  it('fires the most recent slot when it just arrived', () => {
    const now = anchor + 20 * MINUTE + 30_000
    expect(computeDue(every(10), anchor, now)).toEqual({
      due: [anchor + 20 * MINUTE],
      next: anchor + 30 * MINUTE,
      skipped: 1,
    })
  })

  it('drops missed slots with onMissed=skip', () => {
    const now = anchor + 25 * MINUTE
    expect(computeDue(every(10, 'skip'), anchor, now)).toEqual({
      due: [],
      next: anchor + 30 * MINUTE,
      skipped: 2,
    })
  })

  it('recovers one slot with onMissed=catch-up-once', () => {
    const now = anchor + 25 * MINUTE
    expect(computeDue(every(10, 'catch-up-once'), anchor, now)).toEqual({
      due: [anchor + 20 * MINUTE],
      next: anchor + 30 * MINUTE,
      skipped: 1,
    })
  })

  it('respects a custom grace window', () => {
    const now = anchor + 20 * MINUTE + 3 * MINUTE
    expect(computeDue(every(10, 'skip'), anchor, now, 5 * MINUTE).due).toEqual([
      anchor + 20 * MINUTE,
    ])
    expect(computeDue(every(10, 'skip'), anchor, now, MINUTE).due).toEqual([])
  })

  it('returns no due slots when the interval has not elapsed', () => {
    expect(computeDue(every(10), anchor, anchor + 5 * MINUTE)).toEqual({
      due: [],
      next: anchor + 10 * MINUTE,
      skipped: 0,
    })
  })
})

describe('computeDue (cron)', () => {
  const at = (day: number, hour: number) => new Date(2026, 2, day, hour, 0, 0, 0).getTime()

  it('fires when the latest slot is inside the grace window', () => {
    const now = at(2, 9) + 30_000
    expect(computeDue(cron('0 9 * * *'), at(1, 9), now)).toEqual({
      due: [at(2, 9)],
      next: at(3, 9),
      skipped: 0,
    })
  })

  it('drops several missed days with skip and counts them', () => {
    const now = at(4, 10)
    expect(computeDue(cron('0 9 * * *', 'skip'), at(1, 9), now)).toEqual({
      due: [],
      next: at(5, 9),
      skipped: 3,
    })
  })

  it('backs up exactly one slot with catch-up-once', () => {
    const now = at(4, 10)
    expect(computeDue(cron('0 9 * * *', 'catch-up-once'), at(1, 9), now)).toEqual({
      due: [at(4, 9)],
      next: at(5, 9),
      skipped: 2,
    })
  })

  it('keeps the default grace window at two minutes', () => {
    expect(DEFAULT_MISSED_GRACE_MS).toBe(2 * MINUTE)
  })
})

describe('computeDue (degenerate configs)', () => {
  const source = { type: 'schedule', onMissed: 'skip' } as ScheduleSourceConfig

  it('returns nothing for a schedule without cron/everyMin', () => {
    expect(computeDue(source, 0, 1_000_000)).toEqual({ due: [], next: undefined, skipped: 0 })
  })

  it('returns nothing for an invalid cron expression', () => {
    expect(computeDue(cron('bad'), 0, 1_000_000)).toEqual({
      due: [],
      next: undefined,
      skipped: 0,
    })
  })
})
