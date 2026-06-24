/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for isAuthRequiredError — matches the ACP authRequired code / message
 *  and rejects unrelated failures.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isAuthRequiredError } from '../acpAuthError.js'

describe('isAuthRequiredError', () => {
  it('matches the JSON-RPC authRequired code', () => {
    expect(isAuthRequiredError({ code: -32000, message: 'Authentication required' })).toBe(true)
  })

  it('matches by message when no code is present', () => {
    expect(isAuthRequiredError(new Error('Authentication required: log in first'))).toBe(true)
    expect(isAuthRequiredError({ message: 'auth_required' })).toBe(true)
  })

  it('is case-insensitive on the message', () => {
    expect(isAuthRequiredError(new Error('AUTHENTICATION REQUIRED'))).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isAuthRequiredError(new Error('ACP connection closed'))).toBe(false)
    expect(isAuthRequiredError({ code: -32603, message: 'Internal error' })).toBe(false)
  })

  it('rejects non-error values', () => {
    expect(isAuthRequiredError(undefined)).toBe(false)
    expect(isAuthRequiredError(null)).toBe(false)
    expect(isAuthRequiredError('Authentication required')).toBe(false)
  })
})
