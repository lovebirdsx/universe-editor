/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Redaction helpers for the MCP debug client.
 *
 *  A stdio target's `env` and an http target's `headers` carry credentials as often
 *  as not, and an MCP server's stderr routinely prints its own configuration. So no
 *  code path in the client may format a target — or relay a server's diagnostics —
 *  verbatim: everything funnels through this module first.
 *--------------------------------------------------------------------------------------------*/

import type { McpConnectTargetDto } from '../../../shared/ipc/mcpClientService.js'
import { MCP_SECRET_KEY_SOURCE } from '../../../shared/mcp/secretKeyNames.js'

/**
 * Key names that mark the value beside them as a credential. Quotes are part of the
 * key pattern so JSON config dumps (`"token":"…"`) are covered too; the shared
 * source string keeps this list and the renderer's masking rule identical.
 */
const SECRET_KEY = `(?:${MCP_SECRET_KEY_SOURCE})`

const SECRET_ASSIGNMENT_RE = new RegExp(
  `(["']?[\\w.-]*${SECRET_KEY}[\\w.-]*["']?\\s*[:=]\\s*)(?:(?:bearer|basic|token)\\s+)?("[^"]*"|'[^']*'|[^\\s,;&#]+)`,
  'gi',
)
const BEARER_RE = /(bearer\s+)\S+/gi

/** Longest diagnostic line kept; a server printing one huge line must not own memory. */
export const MAX_DIAGNOSTIC_LINE_CHARS = 2_000

/**
 * The subset of a target that is safe to log. stdio keeps the command but only the
 * *count* of args (an arg is the usual place a token hides); http keeps the origin
 * only — path and query both routinely carry credentials.
 */
export interface RedactedMcpTarget {
  readonly kind: McpConnectTargetDto['kind']
  readonly command?: string
  readonly argCount?: number
  readonly origin?: string
}

export function redactTargetForLog(target: McpConnectTargetDto): RedactedMcpTarget {
  if (target.kind === 'stdio') {
    return { kind: 'stdio', command: target.command, argCount: target.args.length }
  }
  return { kind: target.kind, origin: urlOrigin(target.url) }
}

/**
 * Mask credential values in one diagnostic line. Query strings (`?api_key=…`) need
 * no separate rule: the assignment form covers them, since the key match is
 * unanchored.
 */
export function stripSecretLike(text: string): string {
  return text.replace(SECRET_ASSIGNMENT_RE, '$1••••').replace(BEARER_RE, '$1••••')
}

/** Bounded FIFO of masked diagnostic lines, so a chatty server cannot grow memory. */
export class DiagnosticTail {
  private readonly _lines: string[] = []

  constructor(private readonly _maxLines: number) {}

  push(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue
      const clipped =
        line.length > MAX_DIAGNOSTIC_LINE_CHARS
          ? `${line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}…`
          : line
      this._lines.push(stripSecretLike(clipped))
      while (this._lines.length > this._maxLines) this._lines.shift()
    }
  }

  /** The retained lines, newest last, or `''` when nothing was ever written. */
  toString(): string {
    return this._lines.join('\n')
  }

  get size(): number {
    return this._lines.length
  }
}

function urlOrigin(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return '<unparsable-url>'
  }
}
