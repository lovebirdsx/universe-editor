/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  tracker 契约 v1 的共享常量与校验：状态、错误码、runId/idempotencyKey、隐藏标记、
 *  不透明分页游标。协议层与适配器都从这里取，避免两份实现漂移。
 *--------------------------------------------------------------------------------------------*/

export const TRACKER_CONTRACT_VERSION = 1
export const UNIFIED_STATUSES = ['open', 'planned', 'in_progress', 'done', 'closed']
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100
export const MAX_COMMENT_BODY = 20000
export const MAX_RECENT_COMMENTS = 20
export const TRACKER_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export const TRACKER_ERROR_CODES = new Set([
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID',
  'CONFLICT',
  'AUTH',
  'RATE_LIMITED',
  'UNAVAILABLE',
])

const CLAIM_MARKER_PATTERN = /<!-- tracker-claim:([A-Za-z0-9._:-]{1,128}) -->/g
const IDEMPOTENCY_MARKER_PATTERN = /<!-- tracker-idem:([A-Za-z0-9._:-]{1,128}) -->/g
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/
const CURSOR_SKIP_PATTERN = /^\d+$/

export class TrackerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TrackerError'
    this.code = code
  }
}

export function isTrackerErrorCode(value) {
  return TRACKER_ERROR_CODES.has(value)
}

export function assertTrackerKey(value, field) {
  if (typeof value !== 'string' || !TRACKER_KEY_PATTERN.test(value)) {
    throw new TrackerError('INVALID', `${field} 必须为 1-128 个 [A-Za-z0-9._:-] 字符`)
  }
  return value
}

export function assertStatus(value) {
  if (!UNIFIED_STATUSES.includes(value)) {
    throw new TrackerError(
      'INVALID',
      `未知需求状态 ${value}（允许：${UNIFIED_STATUSES.join('/')}）`,
    )
  }
  return value
}

export function assertCommentBody(value) {
  if (typeof value !== 'string' || value.length > MAX_COMMENT_BODY) {
    throw new TrackerError('INVALID', `body 最长 ${MAX_COMMENT_BODY} 个字符`)
  }
  return value
}

export function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TrackerError('INVALID', `limit 必须在 1..${MAX_LIMIT} 之间`)
  }
  return value
}

export function parseSince(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new TrackerError('INVALID', 'since 必须是 ISO 8601 时间字符串')
  }
  const time = Date.parse(value)
  if (Number.isNaN(time)) {
    throw new TrackerError('INVALID', 'since 不是合法的 ISO 8601 时间')
  }
  return new Date(time)
}

export function claimMarker(runId) {
  return `<!-- tracker-claim:${runId} -->`
}

export function idempotencyMarker(key) {
  return `<!-- tracker-idem:${key} -->`
}

export function extractClaimRunIds(content) {
  if (!content) return []
  return [...content.matchAll(CLAIM_MARKER_PATTERN)].map((match) => match[1])
}

export function hasIdempotencyMarker(content, key) {
  return typeof content === 'string' && content.includes(idempotencyMarker(key))
}

export function stripTrackerMarkers(content) {
  if (!content) return ''
  return content
    .replace(CLAIM_MARKER_PATTERN, '')
    .replace(IDEMPOTENCY_MARKER_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function encodeCursor(skip) {
  return Buffer.from(String(skip), 'utf8').toString('base64url')
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)) {
    throw new TrackerError('INVALID', 'cursor 无效')
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!CURSOR_SKIP_PATTERN.test(text)) {
    throw new TrackerError('INVALID', 'cursor 无效')
  }
  const skip = Number(text)
  if (!Number.isSafeInteger(skip) || skip < 0) {
    throw new TrackerError('INVALID', 'cursor 无效')
  }
  return skip
}
