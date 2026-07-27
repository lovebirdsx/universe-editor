/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Detect an ACP "authentication required" failure. The agent raises
 *  `RequestError.authRequired()` (JSON-RPC code -32000, message "Authentication
 *  required…") when it has no usable credentials. The error crosses the wire as a
 *  plain Error, so we match on both the structured code (when present) and the
 *  message text.
 *--------------------------------------------------------------------------------------------*/

/** JSON-RPC error code used by ACP's `RequestError.authRequired()`. */
const AUTH_REQUIRED_CODE = -32000

export function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'number' && code === AUTH_REQUIRED_CODE) return true
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  const lower = message.toLowerCase()
  return lower.includes('authentication required') || lower.includes('auth_required')
}
