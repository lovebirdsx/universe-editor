import { describe, expect, it } from 'vitest'
import {
  STRICT_MODE_EXCLUSION_BUDGET,
  strictModeExcludedTests,
} from '../vitestStrictModeExclusions.js'

describe('StrictMode exclusion list', () => {
  it('only shrinks', () => {
    expect(strictModeExcludedTests.length).toBeLessThanOrEqual(STRICT_MODE_EXCLUSION_BUDGET)
  })

  it('has no duplicate entries', () => {
    expect(new Set(strictModeExcludedTests).size).toBe(strictModeExcludedTests.length)
  })
})
