/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Classify a failed `session/prompt` (or handshake) error for auto-recovery.
 *  The verdict decides whether the session layer may retry / reconnect without
 *  involving the user:
 *
 *    - `transient`  — worth an automatic retry (rate limit, overloaded, 5xx,
 *                     dropped stream). The agent forks report these via
 *                     structured JSON-RPC error data; text patterns are a
 *                     last-resort fallback for third-party agents.
 *    - `quota`      — billing / usage-limit exhausted. Retrying only burns
 *                     time; surface and stop.
 *    - `auth`       — credentials missing/revoked. Never retried (the auth
 *                     guidance flow owns these).
 *    - `agent_crash`— the agent process threw internally (SDK-wrapped bare
 *                     exception). Not retryable in place; the session layer
 *                     hot-reconnects instead (fresh spawn + session/resume).
 *    - `fatal`      — everything else. No retry.
 *
 *  Structured sources honoured (both maintained forks already emit them):
 *    - claude fork: `RequestError.data.errorKind` — the Claude SDK's
 *      categorical SDKAssistantMessageError ('rate_limit' | 'overloaded' |
 *      'server_error' | 'authentication_failed' | 'billing_error' | …).
 *      'unknown' means the CLI itself could not categorise the failure (an
 *      unrecognised proxy/gateway response, say), so it falls through to the
 *      text fallback rather than forcing `fatal`.
 *    - codex fork: `RequestError.data.codexErrorInfo` — 'usageLimitExceeded',
 *      'unauthorized', or { responseStreamDisconnected | httpConnectionFailed |
 *      responseTooManyFailedAttempts: { httpStatusCode } }.
 *    - ACP SDK catch-all: a non-RequestError thrown inside the agent process
 *      is wrapped as `data.details` = the original message. When the message
 *      reads like a JS-engine runtime error (see RUNTIME_ERROR_TEXT) it marks
 *      an agent-internal crash — read BEFORE the -32603 fallback below so the
 *      wrapper's 'Internal error' code is never mistaken for `authRequired`.
 *--------------------------------------------------------------------------------------------*/

export type AcpErrorClass = 'transient' | 'quota' | 'auth' | 'fatal' | 'agent_crash'

export interface AcpErrorVerdict {
  readonly cls: AcpErrorClass
  /** Machine-readable kind when the agent reported one (for telemetry). */
  readonly kind?: string
}

/** claude fork errorKinds that justify an automatic retry. */
const CLAUDE_TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  // The SDK declared the turn over without ever emitting its result (fork-side
  // issue #825): nothing was persisted for the turn, so a retry is safe.
  'no_result',
])

const CLAUDE_QUOTA_KINDS: ReadonlySet<string> = new Set(['billing_error'])
const CLAUDE_AUTH_KINDS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
])

/** Text fallback for agents that report no structured error data. */
const TRANSIENT_TEXT =
  /\b429\b|rate.?limit|overloaded|too many requests|temporarily unavailable|service unavailable|\b5\d\d\b|timed? ?out|econnreset|etimedout|epipe|socket hang up|network error|empty or malformed/i
const QUOTA_TEXT = /quota exceeded|usage limit|billing|insufficient.?quota|credits/i

/**
 * Bare runtime-error phrasings of the major JS engines. A match marks the
 * ACP SDK's catch-all `data.details` (a non-RequestError thrown inside the
 * agent process) as an agent-internal crash rather than a request-level
 * failure: V8 ("Cannot read properties of undefined (reading 'x')" /
 * "x is not a function"), JavaScriptCore ("undefined is not an object
 * (evaluating 'x')" — the phrasing Bun emits), Hermes ("undefined is not
 * a function"), SpiderMonkey ("x is undefined").
 */
const RUNTIME_ERROR_TEXT =
  /cannot read propert|cannot read private member|is not a function|is not a constructor|is not iterable|is not an object|is not defined|\bis undefined\b|\(intermediate value\)|cannot destructure|cannot set propert|right-hand side of 'in'|invalid assignment|assignment to undeclared|too much recursion|maximum call stack|out of memory/i

function readData(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== 'object') return undefined
  const data = (err as { data?: unknown }).data
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
}

function httpStatusOf(info: Record<string, unknown>): number | undefined {
  for (const key of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ]) {
    const v = info[key]
    if (v !== null && typeof v === 'object') {
      const code = (v as { httpStatusCode?: unknown }).httpStatusCode
      if (typeof code === 'number') return code
    }
  }
  return undefined
}

function classifyCodexInfo(info: unknown): AcpErrorVerdict | undefined {
  if (info === null || info === undefined) return undefined
  if (info === 'usageLimitExceeded') return { cls: 'quota', kind: 'usageLimitExceeded' }
  if (info === 'unauthorized') return { cls: 'auth', kind: 'unauthorized' }
  if (typeof info === 'object') {
    const status = httpStatusOf(info as Record<string, unknown>)
    if (status !== undefined) {
      if (status === 401 || status === 403) return { cls: 'auth', kind: `http_${status}` }
      if (status === 429 || status >= 500) return { cls: 'transient', kind: `http_${status}` }
      return { cls: 'fatal', kind: `http_${status}` }
    }
    // Connection-level failure with no status (stream dropped, connect failed):
    // the transport died, not the request — retrying is safe.
    return { cls: 'transient', kind: 'connection' }
  }
  return undefined
}

function classifyClaudeKind(kind: unknown): AcpErrorVerdict | undefined {
  if (typeof kind !== 'string') return undefined
  if (CLAUDE_TRANSIENT_KINDS.has(kind)) return { cls: 'transient', kind }
  if (CLAUDE_QUOTA_KINDS.has(kind)) return { cls: 'quota', kind }
  if (CLAUDE_AUTH_KINDS.has(kind)) return { cls: 'auth', kind }
  // 'unknown' carries no information — the CLI itself could not categorise the
  // failure (e.g. an empty/malformed HTTP 200 body from a proxy), so fall
  // through to the message-text fallback instead of forcing fatal.
  if (kind === 'unknown') return undefined
  return { cls: 'fatal', kind }
}

/**
 * Classify an error raised by an agent round-trip. `fatal` is the conservative
 * default: only errors we positively recognise as transient are auto-retried.
 */
export function classifyAcpError(err: unknown): AcpErrorVerdict {
  const data = readData(err)
  if (data) {
    const fromClaude = classifyClaudeKind(data['errorKind'])
    if (fromClaude) return fromClaude
    const fromCodex = classifyCodexInfo(data['codexErrorInfo'])
    if (fromCodex) return fromCodex
    // The ACP SDK wraps any non-RequestError thrown inside the agent process
    // as `internalError({ details })` — but that bag holds ANY plain-Error
    // message, so gate on a JS-engine runtime-error phrasing: a TypeError
    // deep in the agent's own code is an agent-internal crash, NOT an auth
    // failure (and not retryable in place — the session layer hot-reconnects
    // instead). Other `details` content falls through to the text fallback,
    // where an unrecognised message stays conservatively fatal.
    const details = data['details']
    if (typeof details === 'string' && RUNTIME_ERROR_TEXT.test(details)) {
      return { cls: 'agent_crash', kind: 'internal' }
    }
  }
  const code = (err as { code?: unknown } | undefined)?.code
  if (typeof code === 'number' && code === -32000) return { cls: 'auth' }
  const message = (err as { message?: unknown } | undefined)?.message
  if (typeof message === 'string') {
    const lower = message.toLowerCase()
    if (lower.includes('authentication required') || lower.includes('auth_required')) {
      return { cls: 'auth' }
    }
    if (QUOTA_TEXT.test(message)) return { cls: 'quota' }
    if (TRANSIENT_TEXT.test(message)) return { cls: 'transient' }
  }
  return { cls: 'fatal' }
}
