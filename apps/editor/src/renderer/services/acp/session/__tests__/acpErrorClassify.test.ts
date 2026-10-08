/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  classifyAcpError,
  formatAcpErrorMessage,
  isSessionNotFoundError,
} from '../acpErrorClassify.js'

describe('classifyAcpError', () => {
  it('classifies claude fork structured errorKinds', () => {
    // A throttle is retryable but on a minutes-long budget of its own, so it
    // must stay distinguishable from the few-second `transient` blips.
    expect(classifyAcpError({ data: { errorKind: 'rate_limit' } }).cls).toBe('rate_limited')
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
    // The string kinds the fork's air-extensions table marks retryable; the
    // rest fall through to the text fallback rather than being forced fatal.
    expect(classifyAcpError({ data: { codexErrorInfo: 'rateLimitExceeded' } }).cls).toBe(
      'rate_limited',
    )
    expect(classifyAcpError({ data: { codexErrorInfo: 'serverOverloaded' } }).cls).toBe('transient')
    expect(classifyAcpError({ data: { codexErrorInfo: 'internalServerError' } }).cls).toBe(
      'transient',
    )
    expect(classifyAcpError({ data: { codexErrorInfo: 'contextWindowExceeded' } }).cls).toBe(
      'fatal',
    )
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

  it('splits codex HTTP status into throttle / blip / access', () => {
    // Every structured carrier key the fork can put a status on. 429 is the
    // throttle: a real session died here because codex's own retry loop gives up
    // within seconds while the throttling window lasts minutes.
    for (const key of [
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
    ]) {
      expect(
        classifyAcpError({ data: { codexErrorInfo: { [key]: { httpStatusCode: 429 } } } }).cls,
      ).toBe('rate_limited')
      expect(
        classifyAcpError({ data: { codexErrorInfo: { [key]: { httpStatusCode: 503 } } } }).cls,
      ).toBe('transient')
    }
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

  it('treats the claude CLI usage-accounting TypeError as transient', () => {
    // Real-world shape: a third-party gateway returns usage.iterations[] with
    // an advisor_message entry missing `model`; the CLI's cost accounting then
    // throws TypeError on `model.includes(...)` AFTER the turn's work is done
    // and persisted. The fork forwards the errored result verbatim (errorKind
    // 'unknown' or absent, no `details`), so only the message identifies it.
    // A continue-retry is safe and usually succeeds — the next response rarely
    // carries the bad entry again.
    const jsc = classifyAcpError({
      code: -32603,
      message: "Internal error: undefined is not an object (evaluating 'e.includes')",
      data: { errorKind: 'unknown' },
    })
    expect(jsc.cls).toBe('transient')
    expect(jsc.kind).toBe('cli_usage_accounting_crash')
    // Minified identifier varies across CLI builds; V8 phrasing covered too.
    expect(
      classifyAcpError({
        code: -32603,
        message: "Internal error: API Error: undefined is not an object (evaluating 'Qz.includes')",
      }).cls,
    ).toBe('transient')
    expect(
      classifyAcpError({
        code: -32603,
        message: "Internal error: Cannot read properties of undefined (reading 'includes')",
      }).cls,
    ).toBe('transient')
    // Unrelated `.includes` mentions must not match.
    expect(
      classifyAcpError({ code: -32603, message: 'Internal error: prompt includes bad data' }).cls,
    ).toBe('fatal')
  })

  it('falls back to message text when no structured data', () => {
    expect(classifyAcpError(new Error('HTTP 429 Too Many Requests')).cls).toBe('rate_limited')
    expect(classifyAcpError(new Error('rate limit exceeded, slow down')).cls).toBe('rate_limited')
    expect(classifyAcpError(new Error('server said: too many requests')).cls).toBe('rate_limited')
    expect(classifyAcpError(new Error('service temporarily unavailable')).cls).toBe('transient')
    expect(classifyAcpError(new Error('socket hang up')).cls).toBe('transient')
    expect(
      classifyAcpError(new Error('API returned an empty or malformed response (HTTP 200)')).cls,
    ).toBe('transient')
    expect(classifyAcpError(new Error('usage limit reached')).cls).toBe('quota')
    expect(classifyAcpError(new Error('some random failure')).cls).toBe('fatal')
  })

  it('keeps an exhausted quota out of the rate-limit class', () => {
    // Real throttling bodies mention both ("you exceeded your current quota …
    // 429"), and the two need opposite handling: waiting out a throttle is
    // exactly right, waiting out a spent quota just burns five minutes before
    // showing the same error. Quota wins whenever it is recognisable.
    expect(classifyAcpError(new Error('You exceeded your current quota (HTTP 429)')).cls).toBe(
      'quota',
    )
    expect(
      classifyAcpError(new Error('usage limit reached, rate limit applies until reset')).cls,
    ).toBe('quota')
    expect(classifyAcpError(new Error('billing error: 429 from upstream')).cls).toBe('quota')
    // …and structured verdicts are never overridden by text at all.
    expect(
      classifyAcpError({
        message: 'HTTP 429 Too Many Requests',
        data: { errorKind: 'billing_error' },
      }).cls,
    ).toBe('quota')
    expect(
      classifyAcpError({
        message: 'rate limit',
        data: { codexErrorInfo: 'usageLimitExceeded' },
      }).cls,
    ).toBe('quota')
  })

  it('surfaces the codex textual diagnosis behind the SDK "Internal error"', () => {
    // shape: RequestError.internalError({ message, codexErrorInfo }) — the SDK
    // message is the bare "Internal error" and the provider's own text rides in
    // data.message. Without this the user sees "Internal error" and nothing else.
    expect(
      formatAcpErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: {
          message: 'exceeded retry limit, last status: 429 Too Many Requests',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
      }),
    ).toBe('exceeded retry limit, last status: 429 Too Many Requests')
    // A data bag without that field keeps the previous behaviour.
    expect(formatAcpErrorMessage({ code: -32603, message: 'Internal error' })).toBe(
      'Internal error',
    )
    // details (the SDK catch-all) still wins over the carried message.
    expect(
      formatAcpErrorMessage({
        code: -32603,
        message: 'Internal error',
        data: { details: 'boom', message: 'carried' },
      }),
    ).toBe('Internal error: boom')
  })

  it('reads the diagnosis the codex fork carries in data.message', () => {
    // The terminal error notification is re-thrown as
    // `RequestError.internalError({ message, codexErrorInfo })`: the SDK's own
    // message stays the bare "Internal error" while the provider's text rides in
    // `data.message`. `codexErrorInfo` is optional there — when it is absent the
    // structured branch has nothing, and classifying on the SDK's word alone
    // would call a throttle fatal and skip the five-minute budget entirely.
    expect(
      classifyAcpError({
        code: -32603,
        message: 'Internal error',
        data: { message: 'exceeded retry limit, last status: 429 Too Many Requests' },
      }).cls,
    ).toBe('rate_limited')
    expect(
      classifyAcpError({
        code: -32603,
        message: 'Internal error',
        data: { message: 'upstream said: usage limit reached' },
      }).cls,
    ).toBe('quota')
    // A body without a carried message keeps the old behaviour.
    expect(classifyAcpError({ code: -32603, message: 'Internal error' }).cls).toBe('fatal')
  })

  it('does not read throttle phrasing into ordinary prose', () => {
    // The rate-limit class now buys minutes of silent waiting, so a false
    // positive is expensive: without the leading word boundary, `rate[ _-]?limit`
    // matches the "rate limit" sitting inside "moderate limitation".
    expect(classifyAcpError(new Error('moderate limitation introduced by the patch')).cls).toBe(
      'fatal',
    )
    // …while every real spelling of the throttle still lands, including the
    // "-limited" form a trailing boundary would have broken.
    for (const text of [
      'rate limited, slow down',
      'the account is rate-limited',
      'rate_limit exceeded',
      'rateLimitExceeded',
      'ratelimit: retry later',
    ]) {
      expect(classifyAcpError(new Error(text)).cls).toBe('rate_limited')
    }
  })

  it('defaults to fatal for unknown shapes', () => {
    expect(classifyAcpError(undefined).cls).toBe('fatal')
    expect(classifyAcpError(null).cls).toBe('fatal')
    expect(classifyAcpError({}).cls).toBe('fatal')
  })
})

describe('formatAcpErrorMessage', () => {
  it('rewrites a Codex writer-lock details payload', () => {
    expect(
      formatAcpErrorMessage({
        message: 'Internal error',
        data: { details: 'thread 01a0aec6 already has an active writer' },
      }),
    ).toBe(
      'This session is in use by another Codex client. Close it in the official Codex app and try again.',
    )
  })

  it('appends data.details when the message does not already contain them', () => {
    expect(
      formatAcpErrorMessage({
        message: 'Internal error',
        data: { details: 'paginated threads do not support thread/read(includeTurns=true)' },
      }),
    ).toBe('Internal error: paginated threads do not support thread/read(includeTurns=true)')
  })

  it('does not duplicate details already present in the message', () => {
    expect(
      formatAcpErrorMessage({
        message: 'Internal error: boom from agent',
        data: { details: 'boom from agent' },
      }),
    ).toBe('Internal error: boom from agent')
  })

  it('uses a plain Error message', () => {
    expect(formatAcpErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns an empty string for unknown shapes', () => {
    expect(formatAcpErrorMessage(undefined)).toBe('')
    expect(formatAcpErrorMessage(null)).toBe('')
  })
})

describe('isSessionNotFoundError', () => {
  it('matches the JSON-RPC resourceNotFound code', () => {
    expect(isSessionNotFoundError({ code: -32002, message: 'Resource not found: abc' })).toBe(true)
  })

  it('does not match other JSON-RPC codes', () => {
    // -32000 is authRequired: recoverable, the user must stay informed.
    expect(isSessionNotFoundError({ code: -32000, message: 'Authentication required' })).toBe(false)
    expect(isSessionNotFoundError({ code: -32603, message: 'Internal error' })).toBe(false)
  })

  it('falls back to anchored message text for agents with no error code', () => {
    expect(isSessionNotFoundError(new Error('Resource not found: abc'))).toBe(true)
    expect(isSessionNotFoundError(new Error('resource not found'))).toBe(true)
    // Mid-sentence mentions must not count as the agent's verdict.
    expect(isSessionNotFoundError(new Error('agent crashed: Resource not found'))).toBe(false)
  })

  it('is false for unknown shapes', () => {
    expect(isSessionNotFoundError(undefined)).toBe(false)
    expect(isSessionNotFoundError(null)).toBe(false)
    expect(isSessionNotFoundError({})).toBe(false)
    expect(isSessionNotFoundError(new Error('ACP initialize timed out after 1ms'))).toBe(false)
  })

  it('keeps not-found classified as fatal (never auto-retried)', () => {
    expect(classifyAcpError({ code: -32002, message: 'Resource not found: abc' }).cls).toBe('fatal')
  })
})
