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
 *    - `fatal`      — everything else. No retry.
 *
 *  Structured sources honoured (both maintained forks already emit them):
 *    - claude fork: `RequestError.data.errorKind` — the Claude SDK's
 *      categorical SDKAssistantMessageError ('rate_limit' | 'overloaded' |
 *      'server_error' | 'authentication_failed' | 'billing_error' | …).
 *    - codex fork: `RequestError.data.codexErrorInfo` — 'usageLimitExceeded',
 *      'unauthorized', or { responseStreamDisconnected | httpConnectionFailed |
 *      responseTooManyFailedAttempts: { httpStatusCode } }.
 *--------------------------------------------------------------------------------------------*/

export type AcpErrorClass = 'transient' | 'quota' | 'auth' | 'fatal'

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
  /\b429\b|rate.?limit|overloaded|too many requests|temporarily unavailable|service unavailable|\b5\d\d\b|timed? ?out|econnreset|etimedout|epipe|socket hang up|network error/i
const QUOTA_TEXT = /quota exceeded|usage limit|billing|insufficient.?quota|credits/i

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
