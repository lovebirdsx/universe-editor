import { describe, expect, it } from 'vitest'
import { nextCronTime, parseCron } from '../cron.js'

const local = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

function parsed(expr: string) {
  const result = parseCron(expr)
  if (!result.ok) throw new Error(`expected valid cron: ${result.error}`)
  return result.cron
}

describe('parseCron', () => {
  it('parses wildcards, steps, lists and ranges', () => {
    expect(parsed('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parsed('5,10-12 * * * *').minutes).toEqual([5, 10, 11, 12])
    expect(parsed('0-30/10 * * * *').minutes).toEqual([0, 10, 20, 30])
    expect(parsed('10/20 * * * *').minutes).toEqual([10, 30, 50])
    expect(parsed('0 9 1-5 1,6,12 1-5').hours).toEqual([9])
    expect(parsed('0 9 1-5 1,6,12 1-5').months).toEqual([1, 6, 12])
    expect(parsed('0 9 1-5 1,6,12 1-5').daysOfMonth).toEqual([1, 2, 3, 4, 5])
  })

  it('normalizes Sunday 0 and 7 to the same day', () => {
    expect(parsed('0 0 * * 0').daysOfWeek).toEqual([0])
    expect(parsed('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parsed('0 0 * * 5-7').daysOfWeek).toEqual([0, 5, 6])
  })

  it('tracks whether day fields are restricted', () => {
    expect(parsed('0 0 * * *').domRestricted).toBe(false)
    expect(parsed('0 0 * * *').dowRestricted).toBe(false)
    expect(parsed('0 0 1 * *').domRestricted).toBe(true)
    expect(parsed('0 0 * * 1').dowRestricted).toBe(true)
  })

  it('rejects malformed expressions', () => {
    for (const expr of [
      '',
      '0 0 * *',
      '0 0 * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '10-5 * * * *',
      '*/0 * * * *',
      'a * * * *',
      '1-2-3 * * * *',
    ]) {
      const result = parseCron(expr)
      expect(result.ok, expr).toBe(false)
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    }
  })
})

describe('nextCronTime', () => {
  it('returns the next matching minute strictly after the input', () => {
    const cron = parsed('0 9 * * *')
    expect(nextCronTime(cron, local(2026, 3, 2, 8, 30))).toBe(local(2026, 3, 2, 9, 0))
    expect(nextCronTime(cron, local(2026, 3, 2, 9, 0))).toBe(local(2026, 3, 3, 9, 0))
    expect(nextCronTime(cron, local(2026, 3, 2, 9, 0) - 1)).toBe(local(2026, 3, 2, 9, 0))
  })

  it('honors step values', () => {
    const cron = parsed('*/15 * * * *')
    expect(nextCronTime(cron, local(2026, 3, 2, 10, 1))).toBe(local(2026, 3, 2, 10, 15))
    expect(nextCronTime(cron, local(2026, 3, 2, 10, 45))).toBe(local(2026, 3, 2, 11, 0))
  })

  it('uses OR semantics when day-of-month and day-of-week are both restricted', () => {
    // 2026-03-06 is a Friday, 2026-03-13 is both the 13th and a Friday.
    const cron = parsed('0 0 13 * 5')
    expect(nextCronTime(cron, local(2026, 3, 1, 12, 0))).toBe(local(2026, 3, 6))
    expect(nextCronTime(cron, local(2026, 3, 6))).toBe(local(2026, 3, 13))
    expect(nextCronTime(parsed('0 0 13 * *'), local(2026, 3, 1, 12, 0))).toBe(local(2026, 3, 13))
    expect(nextCronTime(parsed('0 0 * * 5'), local(2026, 3, 1, 12, 0))).toBe(local(2026, 3, 6))
  })

  it('skips short months and finds leap days', () => {
    expect(nextCronTime(parsed('0 0 31 * *'), local(2026, 4, 1))).toBe(local(2026, 5, 31))
    expect(nextCronTime(parsed('0 0 29 2 *'), local(2026, 3, 1))).toBe(local(2028, 2, 29))
  })

  it('returns undefined for an impossible schedule', () => {
    expect(nextCronTime(parsed('0 0 31 2 *'), local(2026, 1, 1))).toBeUndefined()
  })
})
