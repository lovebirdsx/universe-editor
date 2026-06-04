import { describe, expect, it } from 'vitest'
import { satisfies } from '@universe-editor/extensions-common'

describe('satisfies', () => {
  it('matches the wildcard and empty ranges', () => {
    expect(satisfies('0.1.0', '*')).toBe(true)
    expect(satisfies('9.9.9', 'x')).toBe(true)
    expect(satisfies('1.2.3', '')).toBe(true)
  })

  it('matches exact and =-prefixed versions', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '1.2.4')).toBe(false)
  })

  it('matches partial versions as ranges', () => {
    expect(satisfies('1.5.2', '1')).toBe(true)
    expect(satisfies('2.0.0', '1')).toBe(false)
    expect(satisfies('1.2.9', '1.2')).toBe(true)
    expect(satisfies('1.3.0', '1.2')).toBe(false)
    expect(satisfies('1.2.9', '1.x')).toBe(true)
    expect(satisfies('1.2.9', '1.2.*')).toBe(true)
  })

  it('honours caret on a 1.x base (locks the major)', () => {
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true)
    expect(satisfies('1.2.0', '^1.2.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfies('1.1.0', '^1.2.0')).toBe(false)
  })

  it('honours caret on a 0.x base (locks the minor)', () => {
    expect(satisfies('0.1.0', '^0.1.0')).toBe(true)
    expect(satisfies('0.1.9', '^0.1.0')).toBe(true)
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfies('0.0.9', '^0.1.0')).toBe(false)
  })

  it('honours tilde (locks the minor)', () => {
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false)
  })

  it('honours comparison operators', () => {
    expect(satisfies('1.2.3', '>=1.2.0')).toBe(true)
    expect(satisfies('1.1.0', '>=1.2.0')).toBe(false)
    expect(satisfies('1.0.0', '<1.2.0')).toBe(true)
    expect(satisfies('1.2.0', '<=1.2.0')).toBe(true)
    expect(satisfies('1.3.0', '>1.2.0')).toBe(true)
  })

  it('fails closed on unparseable versions and compound ranges', () => {
    expect(satisfies('not-a-version', '^1.0.0')).toBe(false)
    expect(satisfies('1.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
    expect(satisfies('1.0.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfies('1.0.0', '1.0.0 - 2.0.0')).toBe(false)
  })
})
