export const MOBILE_ERROR_CODES = [
  'unauthorized',
  'forbidden_operation',
  'session_not_found',
  'session_read_only',
  'stale_request',
  'workspace_not_open',
  'not_supported',
  'rate_limited',
  'protocol_mismatch',
  'bad_request',
  'internal',
] as const

export type MobileErrorCode = (typeof MOBILE_ERROR_CODES)[number]

const MOBILE_ERROR_CODE_SET: ReadonlySet<string> = new Set(MOBILE_ERROR_CODES)

export function isMobileErrorCode(value: unknown): value is MobileErrorCode {
  return typeof value === 'string' && MOBILE_ERROR_CODE_SET.has(value)
}

/** Shape shared by the HTTP pairing API and `server_error`. */
export interface ApiError {
  code: MobileErrorCode
  message: string
}

/**
 * Private WebSocket close codes (RFC 6455 4000–4999). Kept distinct from HTTP
 * status codes: the gateway never reuses an HTTP response code as a close code.
 */
export const MOBILE_CLOSE_CODES = {
  PROTOCOL_MISMATCH: 4400,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  HELLO_TIMEOUT: 4408,
} as const

export const { PROTOCOL_MISMATCH, UNAUTHORIZED, REVOKED, HELLO_TIMEOUT } = MOBILE_CLOSE_CODES

export type MobileCloseCode = (typeof MOBILE_CLOSE_CODES)[keyof typeof MOBILE_CLOSE_CODES]
