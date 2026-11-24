import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetScmFocusStateForTests,
  getHandledScmRevealTick,
  getScmFocusRegion,
  getScmFocusedPath,
  markScmRevealHandled,
  rememberScmFocusRegion,
  rememberScmFocusedPath,
} from '../scmFocusState.js'

beforeEach(() => _resetScmFocusStateForTests())

describe('scmFocusState', () => {
  it('defaults a new repository to the commit input', () => {
    expect(getScmFocusRegion('D:/repo')).toBe('input')
    expect(getScmFocusedPath('D:/repo')).toBeUndefined()
  })

  it('remembers the region and the focused file independently', () => {
    rememberScmFocusRegion('D:/repo', 'tree')
    rememberScmFocusedPath('D:/repo', 'D:/repo/a.ts')

    expect(getScmFocusRegion('D:/repo')).toBe('tree')
    expect(getScmFocusedPath('D:/repo')).toBe('D:/repo/a.ts')

    // Returning to the input keeps the row memory for the next tree visit.
    rememberScmFocusRegion('D:/repo', 'input')
    expect(getScmFocusRegion('D:/repo')).toBe('input')
    expect(getScmFocusedPath('D:/repo')).toBe('D:/repo/a.ts')
  })

  it('keeps memory per repository', () => {
    rememberScmFocusRegion('D:/a', 'tree')
    rememberScmFocusedPath('D:/a', 'D:/a/x.ts')

    expect(getScmFocusRegion('D:/b')).toBe('input')
    expect(getScmFocusedPath('D:/b')).toBeUndefined()
    expect(getScmFocusedPath('D:/a')).toBe('D:/a/x.ts')
  })

  it('advances the handled reveal tick monotonically', () => {
    expect(getHandledScmRevealTick()).toBe(0)
    markScmRevealHandled(3)
    expect(getHandledScmRevealTick()).toBe(3)
    markScmRevealHandled(2)
    expect(getHandledScmRevealTick()).toBe(3)
  })

  it('reset clears memory and the tick', () => {
    rememberScmFocusRegion('D:/repo', 'tree')
    rememberScmFocusedPath('D:/repo', 'D:/repo/a.ts')
    markScmRevealHandled(7)

    _resetScmFocusStateForTests()

    expect(getScmFocusRegion('D:/repo')).toBe('input')
    expect(getScmFocusedPath('D:/repo')).toBeUndefined()
    expect(getHandledScmRevealTick()).toBe(0)
  })
})
