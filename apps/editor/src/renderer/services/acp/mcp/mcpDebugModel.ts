/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure functions behind the MCP debug panel: argument summarising for the confirm
 *  dialog, JSON text handling for the params box, and the panel's state shape.
 *
 *  Split out from the service so the masking rules and the JSON edge cases are
 *  testable without DI — and so there is exactly one place that decides what a
 *  credential looks like.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { McpCallResultDto, McpToolInfoDto } from '../../../../shared/ipc/mcpClientService.js'
import { MCP_SECRET_KEY_SOURCE } from '../../../../shared/mcp/secretKeyNames.js'

/**
 * Key names that mark the value beside them as a credential — the same list the
 * main-side redactor uses (`shared/mcp/secretKeyNames`), so what the dialog masks
 * and what main keeps out of its logs cannot drift apart. The match is unanchored
 * on purpose (`max_tokens` is masked as collateral): keeping the two rules identical
 * is worth more than the precision, and the panel's params box still shows the user
 * the arguments they are about to send.
 */
const SECRET_KEY_RE = new RegExp(MCP_SECRET_KEY_SOURCE, 'i')

/** Longest literal string kept verbatim; anything longer becomes `<string N chars>`. */
const MAX_STRING_CHARS = 120

const MAX_DEPTH = 8

export type McpTransportName = 'stdio' | 'http' | 'sse'

export type McpDebugConnectionState = 'idle' | 'connecting' | 'connected' | 'failed'

export interface McpDebugCallEntry {
  readonly id: string
  readonly tool: string
  readonly paramsText: string
  readonly startedAt: number
  readonly durationMs: number
  readonly isError: boolean
  readonly result: McpCallResultDto | undefined
  /** Editor-side failure (transport, timeout, unknown connection) — not a server reply. */
  readonly error: string | undefined
}

/**
 * Everything one debugger tab remembers.
 *
 * Fields are declared `T | undefined` rather than `x?: T` on purpose: the service
 * patches this record in place (`{...state, ...patch}`) and refuses to clear an
 * optional property under `exactOptionalPropertyTypes`. An explicit `undefined`
 * keeps clearing expressible without casts.
 */
export interface McpDebugPanelState {
  readonly key: string
  readonly sessionId: string
  readonly serverName: string
  readonly transport: McpTransportName
  /** Redacted "what am I about to talk to" line, e.g. `stdio: node server.cjs (2 args)`. */
  readonly targetSummary: string
  readonly connection: McpDebugConnectionState
  readonly connectionError: string | undefined
  readonly serverVersion: string | undefined
  readonly instructions: string | undefined
  readonly tools: readonly McpToolInfoDto[]
  readonly toolsError: string | undefined
  readonly selectedTool: string | undefined
  /** True once the user typed in the params box — stops the schema skeleton from overwriting. */
  readonly paramsDirty: boolean
  readonly paramsText: string
  readonly running: boolean
  readonly lastResult: McpCallResultDto | undefined
  /** Editor-side failure (transport, timeout, unknown connection) — not a server reply. */
  readonly lastError: string | undefined
  readonly history: readonly McpDebugCallEntry[]
  /** Standing reminder shown for the whole tab. */
  readonly warning: string | undefined
}

/**
 * JSON for display, with a shape for the two things `JSON.stringify` returns
 * `undefined` for (a bare `undefined`, and anything unserializable).
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return '<unserializable>'
  }
}

/**
 * The argument summary the confirm dialog shows. Credential-looking keys are
 * masked and long strings are elided *before* stringifying, so a pasted secret
 * never reaches the DOM even in truncated form.
 */
export function summarizeParamsForDialog(value: unknown, maxChars = 600): string {
  const text = prettyJson(maskSecrets(value, 0))
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)`
}

/** The dialog's `detail`: what will be dialled, and with what. */
export function buildConfirmDetail(args: {
  readonly serverName: string
  readonly transport: McpTransportName
  readonly tool: string
  readonly params: unknown
}): string {
  const { serverName, transport, tool, params } = args
  return [
    `Server:   ${serverName} (${transport})`,
    `Tool:     ${tool}`,
    'Params:',
    summarizeParamsForDialog(params),
  ].join('\n')
}

/** One-line, credential-free description of a connect target. */
export function describeTarget(target: {
  readonly kind: McpTransportName
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
}): string {
  if (target.kind === 'stdio') {
    const argCount = target.args?.length ?? 0
    return `stdio: ${target.command ?? ''} (${argCount} ${argCount === 1 ? 'arg' : 'args'})`
  }
  return `${target.kind}: ${originOf(target.url ?? '')}`
}

export type ParamsParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/** Parse the params box: it must be a JSON object (an array or scalar is not arguments). */
export function parseParamsText(text: string): ParamsParseResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'Arguments must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/**
 * A starting point for the params box, derived from a tool's `inputSchema`: every
 * declared property, with a placeholder of the right kind. Only used while the
 * user has not typed anything — a skeleton that clobbered real input would be
 * worse than no skeleton.
 */
export function buildParamsSkeleton(inputSchema: unknown): string {
  return prettyJson(skeletonValue(inputSchema, 0))
}

function skeletonValue(schema: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH - 2 || schema === null || typeof schema !== 'object') return null
  const node = schema as Record<string, unknown>
  if (Array.isArray(node['enum']) && node['enum'].length > 0) return node['enum'][0]
  if (Array.isArray(node['anyOf']) && node['anyOf'].length > 0) {
    return skeletonValue(node['anyOf'][0], depth + 1)
  }
  if (Array.isArray(node['oneOf']) && node['oneOf'].length > 0) {
    return skeletonValue(node['oneOf'][0], depth + 1)
  }
  const type = typeof node['type'] === 'string' ? node['type'] : undefined
  if (type === 'array') return []
  if (type === 'boolean') return false
  if (type === 'number' || type === 'integer') return 0
  if (type === 'string' || type === 'null') return ''
  const properties = node['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const out: Record<string, unknown> = {}
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      out[name] = skeletonValue(sub, depth + 1)
    }
    return out
  }
  if (type === 'object') return {}
  return null
}

/**
 * Turn a transport/IPC failure into something worth reading. The `MCP_*` codes ride
 * the IPC error envelope's `code`; a server's own `isError` reply never reaches here.
 */
export function describeCallError(err: unknown): string {
  if (err === undefined || err === null) {
    return localize('mcpDebug.error.unknown', 'The call failed for an unknown reason.')
  }
  const code = (err as { code?: unknown } | undefined)?.code
  const message = (err as { message?: unknown } | undefined)?.message
  const detail = typeof message === 'string' && message.length > 0 ? message : String(err)
  switch (code) {
    case 'MCP_NEEDS_AUTH':
      return localize(
        'mcpDebug.error.needsAuth',
        'This MCP server needs an interactive login, which the debugger cannot do.',
      )
    case 'MCP_SERVER_ERROR':
      // The server understood and refused. Its own words are the message; calling
      // that a protocol violation (as this used to) sent users hunting the wrong bug.
      return localize('mcpDebug.error.server', 'The server rejected the call: {detail}', {
        detail,
      })
    case 'MCP_PROTOCOL_ERROR':
      return localize('mcpDebug.error.protocol', 'The server broke the MCP protocol: {detail}', {
        detail,
      })
    default:
      return detail
  }
}

function maskSecrets(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '<max depth>'
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `<string ${value.length} chars>` : value
  }
  if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? '••••' : maskSecrets(entry, depth + 1)
    }
    return out
  }
  return value
}

function originOf(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return '<unparsable-url>'
  }
}
