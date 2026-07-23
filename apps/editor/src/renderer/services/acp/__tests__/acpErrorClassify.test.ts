/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { classifyAcpError } from '../acpErrorClassify.js'

describe('classifyAcpError', () => {
  it('classifies claude fork structured errorKinds', () => {
    expect(classifyAcpError({ data: { errorKind: 'rate_limit' } }).cls).toBe('transient')
    expect(classifyAcpError({ data: { errorKind: 'overloaded' } }).cls).toBe('transient')
    expect(classifyAcpError({ data: { errorKind: 'server_error' } }).cls).toBe('transient')
    expect(classifyAcpError({ data: { errorKind: 'no_result' } }).cls).toBe('transient')
    expect(classifyAcpError({ data: { errorKind: 'billing_error' } }).cls).toBe('quota')
    expect(classifyAcpError({ data: { errorKind: 'authentication_failed' } }).cls).toBe('auth')
    expect(classifyAcpError({ data: { errorKind: 'invalid_request' } }).cls).toBe('fatal')
  })

  it('classifies codex fork codexErrorInfo', () => {
    expect(classifyAcpError({ data: { codexErrorInfo: 'usageLimitExceeded' } }).cls).toBe('quota')
    expect(classifyAcpError({ data: { codexErrorInfo: 'unauthorized' } }).cls).toBe('auth')
    expect(
      classifyAcpError({
        data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
      }).cls,
    ).toBe('transient')
    expect(
      classifyAcpError({
        data: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } },
      }).cls,
    ).toBe('transient')
    expect(
      classifyAcpError({
        data: { codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } },
      }).cls,
    ).toBe('auth')
    expect(
      classifyAcpError({
        data: { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 400 } } },
      }).cls,
    ).toBe('fatal')
  })

  it('treats a codex connection failure with no status as transient', () => {
    expect(
      classifyAcpError({ data: { codexErrorInfo: { responseStreamDisconnected: {} } } }).cls,
    ).toBe('transient')
  })

  it('recognises auth via JSON-RPC code', () => {
    expect(classifyAcpError({ code: -32000, message: 'Authentication required' }).cls).toBe('auth')
  })

  it('falls back to message text when no structured data', () => {
    expect(classifyAcpError(new Error('HTTP 429 Too Many Requests')).cls).toBe('transient')
    expect(classifyAcpError(new Error('service temporarily unavailable')).cls).toBe('transient')
    expect(classifyAcpError(new Error('socket hang up')).cls).toBe('transient')
    expect(classifyAcpError(new Error('usage limit reached')).cls).toBe('quota')
    expect(classifyAcpError(new Error('some random failure')).cls).toBe('fatal')
  })

  it('defaults to fatal for unknown shapes', () => {
    expect(classifyAcpError(undefined).cls).toBe('fatal')
    expect(classifyAcpError(null).cls).toBe('fatal')
    expect(classifyAcpError({}).cls).toBe('fatal')
  })
})
