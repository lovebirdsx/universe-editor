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

  it('lets claude errorKind unknown fall through to the text fallback', () => {
    // Real-world shape from the claude fork when a proxy/gateway mangles the
    // API response: the CLI cannot categorise it, only the message tells.
    expect(
      classifyAcpError({
        code: -32603,
        message:
          'Internal error: API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request',
        data: { errorKind: 'unknown' },
      }).cls,
    ).toBe('transient')
    // …but an unknown kind with no recognisable text stays conservatively fatal.
    expect(
      classifyAcpError({ message: 'Internal error: something odd', data: { errorKind: 'unknown' } })
        .cls,
    ).toBe('fatal')
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

  it('classifies the SDK catch-all wrapper (data.details) as agent_crash, not auth', () => {
    // A bare TypeError thrown inside the agent process is wrapped by the ACP
    // SDK's errorToResult as internalError({ details }) — code -32603. The
    // 'Internal error' code/message must NOT be mistaken for authRequired, and
    // the bare exception marks an agent-internal crash (hot-reconnect tier).
    const screenshot = classifyAcpError({
      code: -32603,
      message: "Internal error: undefined is not an object (evaluating 'e.includes')",
      data: { details: "undefined is not an object (evaluating 'e.includes')" },
    })
    expect(screenshot.cls).toBe('agent_crash')
    expect(screenshot.kind).toBe('internal')
    // Other engine phrasings of a bare runtime error classify the same way.
    for (const details of [
      "Cannot read properties of undefined (reading 'includes')",
      'x is not a function',
      'undefined is not a function',
      'foo is undefined',
      'Maximum call stack size exceeded',
    ]) {
      expect(classifyAcpError({ code: -32603, data: { details } }).cls).toBe('agent_crash')
    }
    // Structured fork data still wins over the wrapper shape.
    expect(classifyAcpError({ code: -32603, data: { errorKind: 'overloaded' } }).cls).toBe(
      'transient',
    )
    // A `details` that does NOT read like a runtime error falls through —
    // agents also wrap plain Errors (e.g. their own "Session not found"), and
    // those must not trigger a hot-reconnect.
    expect(classifyAcpError({ code: -32603, data: { details: 'Session not found' } }).cls).toBe(
      'fatal',
    )
    // A -32603 WITHOUT the details payload keeps its old behaviour (text fallback).
    expect(classifyAcpError({ code: -32603, message: 'Internal error' }).cls).toBe('fatal')
  })

  it('falls back to message text when no structured data', () => {
    expect(classifyAcpError(new Error('HTTP 429 Too Many Requests')).cls).toBe('transient')
    expect(classifyAcpError(new Error('service temporarily unavailable')).cls).toBe('transient')
    expect(classifyAcpError(new Error('socket hang up')).cls).toBe('transient')
    expect(
      classifyAcpError(new Error('API returned an empty or malformed response (HTTP 200)')).cls,
    ).toBe('transient')
    expect(classifyAcpError(new Error('usage limit reached')).cls).toBe('quota')
    expect(classifyAcpError(new Error('some random failure')).cls).toBe('fatal')
  })

  it('defaults to fatal for unknown shapes', () => {
    expect(classifyAcpError(undefined).cls).toBe('fatal')
    expect(classifyAcpError(null).cls).toBe('fatal')
    expect(classifyAcpError({}).cls).toBe('fatal')
  })
})
