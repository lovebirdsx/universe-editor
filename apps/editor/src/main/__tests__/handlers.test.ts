import { describe, expect, it } from 'vitest'
import { handlePing } from '../handlers.js'

describe('handlePing', () => {
  it('returns pong with both timestamps', () => {
    const fixedNow = () => 1_700_000_000_000
    const result = handlePing(1_699_999_999_000, fixedNow)
    expect(result).toEqual({
      pong: true,
      rendererSentAt: 1_699_999_999_000,
      mainReceivedAt: 1_700_000_000_000,
    })
  })

  it('uses Date.now by default', () => {
    const before = Date.now()
    const result = handlePing(before)
    expect(result.pong).toBe(true)
    expect(result.mainReceivedAt).toBeGreaterThanOrEqual(before)
  })
})
