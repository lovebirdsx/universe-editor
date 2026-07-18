import { describe, expect, it } from 'vitest'
import { isBenignError } from '../errors.js'

describe('isBenignError', () => {
  it('flags the Monaco diff-worker mid-flight dispose error (Error object)', () => {
    expect(isBenignError(new Error('no diff result available'))).toBe(true)
  })

  it('flags it as a bare string too', () => {
    expect(isBenignError('Error: no diff result available')).toBe(true)
  })

  it('flags the ResizeObserver loop warning', () => {
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(
      true,
    )
  })

  it('does not flag genuine errors', () => {
    expect(isBenignError(new Error('TypeError: cannot read property x of undefined'))).toBe(false)
    expect(isBenignError('some other failure')).toBe(false)
    expect(isBenignError(undefined)).toBe(false)
    expect(isBenignError(null)).toBe(false)
  })
})
