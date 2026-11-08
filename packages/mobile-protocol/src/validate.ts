import { isMobileErrorCode } from './errors.js'
import type {
  ClientFrame,
  HelloFrame,
  HelloOkFrame,
  InboxSnapshotFrame,
  MobileSessionBucket,
  MobileSessionRef,
  MobileSessionSummary,
  PingFrame,
  PongFrame,
  ServerErrorFrame,
  ServerFrame,
  SubscribeInboxFrame,
} from './frames.js'
import { MOBILE_SESSION_BUCKETS } from './frames.js'
import type { PairDevicePlatform, PairRequest } from './pairing.js'
import { isValidPairCodeShape, normalizePairCode, PAIR_DEVICE_PLATFORMS } from './pairing.js'
import { MOBILE_PROTOCOL_VERSION } from './version.js'

/**
 * Compared against JS string length (UTF-16 code units), not encoded bytes.
 * The transport is JSON text and every user-controlled string is capped far
 * below this, so exact UTF-8 accounting would add complexity without changing
 * the rejection outcome.
 */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024
export const MAX_TOKEN_LENGTH = 128
export const MAX_DEVICE_NAME_LENGTH = 64
export const MAX_CLIENT_VERSION_LENGTH = 64
export const MAX_SERVER_VERSION_LENGTH = 64
export const MAX_CAPABILITIES = 32
export const MAX_ID_LENGTH = 128
export const MAX_TITLE_LENGTH = 512
export const MAX_WORKSPACE_NAME_LENGTH = 256

export type ParseErrorCode = 'bad_request' | 'protocol_mismatch'

export interface ParseError {
  code: ParseErrorCode
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ParseError }

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function fail<T>(code: ParseErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function parseJsonObject(text: string): Result<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('bad_request', 'frame is not valid JSON')
  }
  if (!isRecord(parsed)) return fail('bad_request', 'frame must be a JSON object')
  return ok(parsed)
}

function parseCapabilities(value: unknown): Result<string[]> {
  if (!Array.isArray(value)) return fail('bad_request', 'capabilities must be an array')
  if (value.length > MAX_CAPABILITIES) {
    return fail('bad_request', `capabilities must contain at most ${MAX_CAPABILITIES} entries`)
  }
  const capabilities: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return fail('bad_request', 'capabilities entries must be strings')
    }
    capabilities.push(item)
  }
  return ok(capabilities)
}

export function parseClientFrame(text: string): Result<ClientFrame> {
  if (text.length > MAX_CLIENT_FRAME_BYTES) {
    return fail('bad_request', `frame exceeds ${MAX_CLIENT_FRAME_BYTES} characters`)
  }
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const frame = parsed.value
  const type = frame.type
  if (typeof type !== 'string') return fail('bad_request', 'frame.type must be a string')
  switch (type) {
    case 'hello':
      return parseHelloFrame(frame)
    case 'ping':
      return parsePingFrame(frame)
    case 'subscribe_inbox':
      return parseSubscribeInboxFrame(frame)
    case 'unsubscribe_inbox':
      return ok({ type: 'unsubscribe_inbox' })
    default:
      return fail('bad_request', `unknown client frame type: ${type}`)
  }
}

export function parseServerFrame(text: string): Result<ServerFrame> {
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const frame = parsed.value
  const type = frame.type
  if (typeof type !== 'string') return fail('bad_request', 'frame.type must be a string')
  switch (type) {
    case 'hello_ok':
      return parseHelloOkFrame(frame)
    case 'pong':
      return parsePongFrame(frame)
    case 'inbox_snapshot':
      return parseInboxSnapshotFrame(frame)
    case 'server_error':
      return parseServerErrorFrame(frame)
    case 'device_revoked':
      return ok({ type: 'device_revoked' })
    default:
      return fail('bad_request', `unknown server frame type: ${type}`)
  }
}

export function parsePairRequest(json: unknown): Result<PairRequest> {
  if (!isRecord(json)) return fail('bad_request', 'pair request must be a JSON object')
  const rawCode = json.code
  if (typeof rawCode !== 'string') return fail('bad_request', 'code must be a string')
  const code = normalizePairCode(rawCode)
  if (!isValidPairCodeShape(code)) return fail('bad_request', 'code is not a valid pairing code')
  const deviceName = json.deviceName
  if (!isNonEmptyBoundedString(deviceName, MAX_DEVICE_NAME_LENGTH)) {
    return fail('bad_request', `deviceName must be 1–${MAX_DEVICE_NAME_LENGTH} characters`)
  }
  const platform = json.platform
  if (typeof platform !== 'string' || !isPairDevicePlatform(platform)) {
    return fail('bad_request', 'platform must be ios, android, or other')
  }
  return ok({ code, deviceName, platform })
}

export function serializeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame)
}

function parseHelloFrame(frame: Record<string, unknown>): Result<HelloFrame> {
  const protocolVersion = frame.protocolVersion
  if (!isNonNegativeInteger(protocolVersion)) {
    return fail('bad_request', 'hello.protocolVersion must be a non-negative integer')
  }
  if (protocolVersion !== MOBILE_PROTOCOL_VERSION) {
    return fail('protocol_mismatch', `unsupported protocol version: ${protocolVersion}`)
  }
  const token = frame.token
  if (!isNonEmptyBoundedString(token, MAX_TOKEN_LENGTH)) {
    return fail('bad_request', `hello.token must be 1–${MAX_TOKEN_LENGTH} characters`)
  }
  const clientVersion = frame.clientVersion
  if (!isBoundedString(clientVersion, MAX_CLIENT_VERSION_LENGTH)) {
    return fail('bad_request', `hello.clientVersion must be at most ${MAX_CLIENT_VERSION_LENGTH}`)
  }
  const capabilities = parseCapabilities(frame.capabilities)
  if (!capabilities.ok) return capabilities
  return ok({
    type: 'hello',
    protocolVersion,
    token,
    clientVersion,
    capabilities: capabilities.value,
  })
}

function parsePingFrame(frame: Record<string, unknown>): Result<PingFrame> {
  const t = frame.t
  if (!isFiniteNumber(t)) return fail('bad_request', 'ping.t must be a finite number')
  return ok({ type: 'ping', t })
}

function parseSubscribeInboxFrame(frame: Record<string, unknown>): Result<SubscribeInboxFrame> {
  const afterSeq = frame.afterSeq
  if (afterSeq === undefined) return ok({ type: 'subscribe_inbox' })
  if (!isNonNegativeInteger(afterSeq)) {
    return fail('bad_request', 'subscribe_inbox.afterSeq must be a non-negative integer')
  }
  return ok({ type: 'subscribe_inbox', afterSeq })
}

function parseHelloOkFrame(frame: Record<string, unknown>): Result<HelloOkFrame> {
  const protocolVersion = frame.protocolVersion
  if (!isNonNegativeInteger(protocolVersion)) {
    return fail('bad_request', 'hello_ok.protocolVersion must be a non-negative integer')
  }
  if (protocolVersion !== MOBILE_PROTOCOL_VERSION) {
    return fail('protocol_mismatch', `unsupported protocol version: ${protocolVersion}`)
  }
  const serverVersion = frame.serverVersion
  if (!isBoundedString(serverVersion, MAX_SERVER_VERSION_LENGTH)) {
    return fail(
      'bad_request',
      `hello_ok.serverVersion must be at most ${MAX_SERVER_VERSION_LENGTH}`,
    )
  }
  const deviceId = frame.deviceId
  if (!isNonEmptyBoundedString(deviceId, MAX_ID_LENGTH)) {
    return fail('bad_request', `hello_ok.deviceId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const serverTime = frame.serverTime
  if (!isFiniteNumber(serverTime)) {
    return fail('bad_request', 'hello_ok.serverTime must be a finite number')
  }
  const capabilities = parseCapabilities(frame.capabilities)
  if (!capabilities.ok) return capabilities
  return ok({
    type: 'hello_ok',
    protocolVersion,
    serverVersion,
    deviceId,
    serverTime,
    capabilities: capabilities.value,
  })
}

function parsePongFrame(frame: Record<string, unknown>): Result<PongFrame> {
  const t = frame.t
  if (!isFiniteNumber(t)) return fail('bad_request', 'pong.t must be a finite number')
  return ok({ type: 'pong', t })
}

function parseInboxSnapshotFrame(frame: Record<string, unknown>): Result<InboxSnapshotFrame> {
  const seq = frame.seq
  if (!isNonNegativeInteger(seq)) {
    return fail('bad_request', 'inbox_snapshot.seq must be a non-negative integer')
  }
  const rawSessions = frame.sessions
  if (!Array.isArray(rawSessions)) {
    return fail('bad_request', 'inbox_snapshot.sessions must be an array')
  }
  const sessions: MobileSessionSummary[] = []
  for (const raw of rawSessions) {
    const session = parseSessionSummary(raw)
    if (!session.ok) return session
    sessions.push(session.value)
  }
  return ok({ type: 'inbox_snapshot', seq, sessions })
}

function parseSessionSummary(value: unknown): Result<MobileSessionSummary> {
  if (!isRecord(value)) {
    return fail('bad_request', 'inbox_snapshot.sessions entries must be objects')
  }
  const ref = parseSessionRef(value.ref)
  if (!ref.ok) return ref
  const agentId = value.agentId
  if (!isNonEmptyBoundedString(agentId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.agentId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const title = value.title
  if (!isBoundedString(title, MAX_TITLE_LENGTH)) {
    return fail('bad_request', `session.title must be at most ${MAX_TITLE_LENGTH} characters`)
  }
  const bucket = value.bucket
  if (typeof bucket !== 'string' || !isMobileSessionBucket(bucket)) {
    return fail('bad_request', 'session.bucket is not a known bucket')
  }
  const workspaceName = value.workspaceName
  if (!isBoundedString(workspaceName, MAX_WORKSPACE_NAME_LENGTH)) {
    return fail(
      'bad_request',
      `session.workspaceName must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`,
    )
  }
  const updatedAt = value.updatedAt
  if (!isFiniteNumber(updatedAt)) {
    return fail('bad_request', 'session.updatedAt must be a finite number')
  }
  return ok({ ref: ref.value, agentId, title, bucket, workspaceName, updatedAt })
}

function parseSessionRef(value: unknown): Result<MobileSessionRef> {
  if (!isRecord(value)) return fail('bad_request', 'session.ref must be an object')
  const windowId = value.windowId
  if (!isNonNegativeInteger(windowId)) {
    return fail('bad_request', 'session.ref.windowId must be a non-negative integer')
  }
  const localId = value.localId
  if (!isNonEmptyBoundedString(localId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.ref.localId must be 1–${MAX_ID_LENGTH} characters`)
  }
  const durableId = value.durableId
  if (durableId === undefined) return ok({ windowId, localId })
  if (!isNonEmptyBoundedString(durableId, MAX_ID_LENGTH)) {
    return fail('bad_request', `session.ref.durableId must be 1–${MAX_ID_LENGTH} characters`)
  }
  return ok({ windowId, localId, durableId })
}

function parseServerErrorFrame(frame: Record<string, unknown>): Result<ServerErrorFrame> {
  const code = frame.code
  if (!isMobileErrorCode(code)) return fail('bad_request', 'server_error.code is not known')
  const message = frame.message
  if (typeof message !== 'string') {
    return fail('bad_request', 'server_error.message must be a string')
  }
  const retryable = frame.retryable
  if (typeof retryable !== 'boolean') {
    return fail('bad_request', 'server_error.retryable must be a boolean')
  }
  return ok({ type: 'server_error', code, message, retryable })
}

const MOBILE_SESSION_BUCKET_SET: ReadonlySet<string> = new Set(MOBILE_SESSION_BUCKETS)

function isMobileSessionBucket(value: unknown): value is MobileSessionBucket {
  return typeof value === 'string' && MOBILE_SESSION_BUCKET_SET.has(value)
}

const PAIR_DEVICE_PLATFORM_SET: ReadonlySet<string> = new Set(PAIR_DEVICE_PLATFORMS)

function isPairDevicePlatform(value: unknown): value is PairDevicePlatform {
  return typeof value === 'string' && PAIR_DEVICE_PLATFORM_SET.has(value)
}
