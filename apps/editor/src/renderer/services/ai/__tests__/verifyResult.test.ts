/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  verifyFailureMessage tests — every probe code must produce a message, and the
 *  status-bearing ones must show the number: "authentication failed" without the
 *  401 tells the user nothing they can act on.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProviderVerifyCode } from '@universe-editor/platform'
import { verifyFailureMessage } from '../verifyResult.js'

const CODES: readonly AiProviderVerifyCode[] = [
  'noProvider',
  'unreachable',
  'timeout',
  'unauthorized',
  'serverError',
  'httpError',
  'noModels',
]

describe('verifyFailureMessage', () => {
  it('produces a non-empty message for every code', () => {
    for (const code of CODES) {
      expect(verifyFailureMessage({ ok: false, modelCount: 0, code }).trim()).not.toBe('')
    }
  })

  it('falls back to a generic message when no code is set', () => {
    expect(verifyFailureMessage({ ok: false, modelCount: 0 }).trim()).not.toBe('')
  })

  it.each([
    ['unauthorized' as const, 401],
    ['serverError' as const, 503],
    ['httpError' as const, 418],
  ])('includes the status for %s', (code, status) => {
    expect(verifyFailureMessage({ ok: false, modelCount: 0, code, status })).toContain(
      String(status),
    )
  })

  it('renders distinct messages for the connectivity codes', () => {
    const unreachable = verifyFailureMessage({ ok: false, modelCount: 0, code: 'unreachable' })
    const timeout = verifyFailureMessage({ ok: false, modelCount: 0, code: 'timeout' })
    const noModels = verifyFailureMessage({ ok: false, modelCount: 0, code: 'noModels' })
    expect(new Set([unreachable, timeout, noModels]).size).toBe(3)
  })
})
