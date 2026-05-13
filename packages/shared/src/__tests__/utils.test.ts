import { describe, it, expect } from 'vitest'
import { formatMoney, cn } from '../utils.js'

describe('formatMoney', () => {
  it('formats USD amount', () => {
    expect(formatMoney(1234.56)).toBe('$1,234.56')
  })

  it('formats EUR amount', () => {
    expect(formatMoney(99.99, 'EUR')).toBe('€99.99')
  })

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('$0.00')
  })
})

describe('cn', () => {
  it('joins class names with a space', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('filters out falsy values', () => {
    expect(cn('foo', false, undefined, null, 'bar')).toBe('foo bar')
  })

  it('returns empty string when all values are falsy', () => {
    expect(cn(false, undefined, null)).toBe('')
  })
})
