/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/performance.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { clearMarks, getMarks, mark } from '../../base/performance.js'

beforeEach(() => {
  // Marks accumulate in a process-global store; reset between tests. A bare
  // clearMarks() keeps the injected `code/timeOrigin` entry.
  clearMarks()
})

describe('performance marks', () => {
  it('records marks in insertion order', () => {
    mark('test/a')
    mark('test/b')
    const names = getMarks().map((m) => m.name)
    expect(names).toContain('test/a')
    expect(names).toContain('test/b')
    expect(names.indexOf('test/a')).toBeLessThan(names.indexOf('test/b'))
  })

  it('exposes a numeric startTime for every mark', () => {
    mark('test/c')
    for (const m of getMarks()) {
      expect(typeof m.startTime).toBe('number')
      expect(Number.isFinite(m.startTime)).toBe(true)
    }
  })

  it('keeps the code/timeOrigin entry after a bare clearMarks()', () => {
    mark('test/d')
    clearMarks()
    const names = getMarks().map((m) => m.name)
    expect(names).not.toContain('test/d')
    expect(names[0]).toBe('code/timeOrigin')
  })

  it('removes only the named mark when clearMarks(name) is given', () => {
    mark('test/keep')
    mark('test/drop')
    clearMarks('test/drop')
    const names = getMarks().map((m) => m.name)
    expect(names).toContain('test/keep')
    expect(names).not.toContain('test/drop')
  })

  it('honors an explicit startTime option', () => {
    mark('test/explicit', { startTime: 12345 })
    const entry = getMarks().find((m) => m.name === 'test/explicit')
    expect(entry?.startTime).toBe(12345)
  })
})
