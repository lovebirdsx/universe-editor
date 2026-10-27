import { describe, expect, it } from 'vitest'
import {
  EXPECTED_COMMAND_FAILURE_NAME,
  markExpectedCommandFailure,
} from '@universe-editor/extensions-common'
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

  it('flags an expected command failure as benign (no Output auto-reveal)', () => {
    expect(isBenignError(markExpectedCommandFailure(new Error('timed out after 30000ms')))).toBe(
      true,
    )
    expect(isBenignError(`${EXPECTED_COMMAND_FAILURE_NAME}: timed out`)).toBe(true)
  })

  it('does not flag genuine errors', () => {
    expect(isBenignError(new Error('TypeError: cannot read property x of undefined'))).toBe(false)
    expect(isBenignError('some other failure')).toBe(false)
    expect(isBenignError(undefined)).toBe(false)
    expect(isBenignError(null)).toBe(false)
  })
})
