/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent Client Protocol (ACP) wire types and constants.
 *
 *  ACP is a JSON-RPC 2.0 protocol with newline-delimited framing: each message
 *  is a JSON object on its own line, terminated by `\n`. The transport is
 *  symmetric — both endpoints may issue requests, send responses, and emit
 *  notifications. We model only the subset the editor needs today.
 *--------------------------------------------------------------------------------------------*/

/** JSON-RPC 2.0 envelope. */
export type JsonRpcId = number | string | null

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

// ---------------------------------------------------------------------------
// ACP method names (subset)
// ---------------------------------------------------------------------------

export const AcpMethods = {
  /** Client → Agent: handshake. */
  Initialize: 'initialize',
  /** Client → Agent: create a new session. */
  NewSession: 'session/new',
  /** Client → Agent: send a user prompt for the active session. */
  SessionPrompt: 'session/prompt',
  /** Client → Agent: cancel the current turn. */
  SessionCancel: 'session/cancel',
  /** Agent → Client (notification): streaming update for the active turn. */
  SessionUpdate: 'session/update',
  /** Agent → Client: request the user's permission for a tool call. */
  RequestPermission: 'session/request_permission',
  /** Agent → Client: read a UTF-8 text file. */
  ReadTextFile: 'fs/read_text_file',
  /** Agent → Client: write a UTF-8 text file. */
  WriteTextFile: 'fs/write_text_file',
} as const

// ---------------------------------------------------------------------------
// Domain payloads
// ---------------------------------------------------------------------------

export interface AcpClientCapabilities {
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean }
}

export interface AcpInitializeParams {
  readonly protocolVersion: number
  readonly clientCapabilities: AcpClientCapabilities
}

export interface AcpInitializeResult {
  readonly protocolVersion: number
  readonly agentCapabilities?: {
    readonly promptCapabilities?: Readonly<Record<string, unknown>>
  }
}

export interface AcpNewSessionParams {
  /** Workspace cwd communicated to the agent. */
  readonly cwd: string
  readonly mcpServers?: readonly unknown[]
}

export interface AcpNewSessionResult {
  readonly sessionId: string
}

export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource'; readonly uri: string }

export interface AcpSessionPromptParams {
  readonly sessionId: string
  readonly prompt: readonly AcpContentBlock[]
}

export interface AcpSessionPromptResult {
  /** 'end_turn' | 'max_tokens' | 'cancelled' | etc. */
  readonly stopReason: string
}

export interface AcpSessionCancelParams {
  readonly sessionId: string
}

/** Variants for `session/update` notifications. We model the ones we render. */
export type AcpSessionUpdate =
  | {
      readonly sessionUpdate: 'agent_message_chunk'
      readonly content: AcpContentBlock
    }
  | {
      readonly sessionUpdate: 'user_message_chunk'
      readonly content: AcpContentBlock
    }
  | {
      readonly sessionUpdate: 'agent_thought_chunk'
      readonly content: AcpContentBlock
    }
  | {
      readonly sessionUpdate: 'tool_call'
      readonly toolCallId: string
      readonly title?: string
      readonly kind?: string
      readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      readonly content?: readonly AcpContentBlock[]
    }
  | {
      readonly sessionUpdate: 'tool_call_update'
      readonly toolCallId: string
      readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      readonly content?: readonly AcpContentBlock[]
    }
  | {
      readonly sessionUpdate: 'plan'
      readonly entries: readonly { readonly content: string; readonly priority?: string }[]
    }

export interface AcpSessionUpdateParams {
  readonly sessionId: string
  readonly update: AcpSessionUpdate
}

export interface AcpRequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: {
    readonly toolCallId: string
    readonly title?: string
    readonly kind?: string
  }
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }[]
}

export interface AcpRequestPermissionResult {
  readonly outcome:
    | { readonly outcome: 'selected'; readonly optionId: string }
    | { readonly outcome: 'cancelled' }
}

export interface AcpReadTextFileParams {
  readonly sessionId: string
  readonly path: string
  readonly line?: number
  readonly limit?: number
}

export interface AcpReadTextFileResult {
  readonly content: string
}

export interface AcpWriteTextFileParams {
  readonly sessionId: string
  readonly path: string
  readonly content: string
}

/** Current ACP protocol version that we advertise. */
export const ACP_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Runtime guards
//
// Peer-initiated traffic comes from a third-party agent process, so we never
// trust the wire payload to match our TypeScript types. These narrow guards
// fail closed and let the caller emit `-32602 Invalid params` instead of
// letting a missing field crash a deeper layer with `-32603 Internal error`.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isContentBlock(v: unknown): v is AcpContentBlock {
  if (!isObject(v)) return false
  switch (v['type']) {
    case 'text':
      return typeof v['text'] === 'string'
    case 'image':
      return typeof v['mimeType'] === 'string' && typeof v['data'] === 'string'
    case 'resource':
      return typeof v['uri'] === 'string'
    default:
      return false
  }
}

function isContentBlockArray(v: unknown): v is readonly AcpContentBlock[] {
  return Array.isArray(v) && v.every(isContentBlock)
}

export function parseReadTextFileParams(v: unknown): AcpReadTextFileParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['path'] !== 'string') return null
  if (v['line'] !== undefined && typeof v['line'] !== 'number') return null
  if (v['limit'] !== undefined && typeof v['limit'] !== 'number') return null
  const out: AcpReadTextFileParams = {
    sessionId: v['sessionId'],
    path: v['path'],
    ...(typeof v['line'] === 'number' ? { line: v['line'] } : {}),
    ...(typeof v['limit'] === 'number' ? { limit: v['limit'] } : {}),
  }
  return out
}

export function parseWriteTextFileParams(v: unknown): AcpWriteTextFileParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  if (typeof v['path'] !== 'string') return null
  if (typeof v['content'] !== 'string') return null
  return {
    sessionId: v['sessionId'],
    path: v['path'],
    content: v['content'],
  }
}

export function parseRequestPermissionParams(v: unknown): AcpRequestPermissionParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  const tc = v['toolCall']
  if (!isObject(tc) || typeof tc['toolCallId'] !== 'string') return null
  if (tc['title'] !== undefined && typeof tc['title'] !== 'string') return null
  if (tc['kind'] !== undefined && typeof tc['kind'] !== 'string') return null
  const optsRaw = v['options']
  if (!Array.isArray(optsRaw)) return null
  const options: AcpRequestPermissionParams['options'][number][] = []
  for (const opt of optsRaw) {
    if (!isObject(opt)) return null
    if (typeof opt['optionId'] !== 'string') return null
    if (typeof opt['name'] !== 'string') return null
    const kind = opt['kind']
    if (
      kind !== undefined &&
      kind !== 'allow_once' &&
      kind !== 'allow_always' &&
      kind !== 'reject_once' &&
      kind !== 'reject_always'
    ) {
      return null
    }
    options.push({
      optionId: opt['optionId'],
      name: opt['name'],
      ...(kind
        ? { kind: kind as 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }
        : {}),
    })
  }
  return {
    sessionId: v['sessionId'],
    toolCall: {
      toolCallId: tc['toolCallId'],
      ...(typeof tc['title'] === 'string' ? { title: tc['title'] } : {}),
      ...(typeof tc['kind'] === 'string' ? { kind: tc['kind'] } : {}),
    },
    options,
  }
}

const TOOL_CALL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])

function parseSessionUpdate(v: unknown): AcpSessionUpdate | null {
  if (!isObject(v)) return null
  const kind = v['sessionUpdate']
  switch (kind) {
    case 'agent_message_chunk':
    case 'user_message_chunk':
    case 'agent_thought_chunk': {
      if (!isContentBlock(v['content'])) return null
      return { sessionUpdate: kind, content: v['content'] } as AcpSessionUpdate
    }
    case 'tool_call': {
      if (typeof v['toolCallId'] !== 'string') return null
      if (v['title'] !== undefined && typeof v['title'] !== 'string') return null
      if (v['kind'] !== undefined && typeof v['kind'] !== 'string') return null
      if (v['status'] !== undefined && !TOOL_CALL_STATUSES.has(v['status'] as string)) return null
      if (v['content'] !== undefined && !isContentBlockArray(v['content'])) return null
      return {
        sessionUpdate: 'tool_call',
        toolCallId: v['toolCallId'],
        ...(typeof v['title'] === 'string' ? { title: v['title'] } : {}),
        ...(typeof v['kind'] === 'string' ? { kind: v['kind'] } : {}),
        ...(typeof v['status'] === 'string'
          ? { status: v['status'] as 'pending' | 'in_progress' | 'completed' | 'failed' }
          : {}),
        ...(v['content'] !== undefined
          ? { content: v['content'] as readonly AcpContentBlock[] }
          : {}),
      }
    }
    case 'tool_call_update': {
      if (typeof v['toolCallId'] !== 'string') return null
      if (v['status'] !== undefined && !TOOL_CALL_STATUSES.has(v['status'] as string)) return null
      if (v['content'] !== undefined && !isContentBlockArray(v['content'])) return null
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: v['toolCallId'],
        ...(typeof v['status'] === 'string'
          ? { status: v['status'] as 'pending' | 'in_progress' | 'completed' | 'failed' }
          : {}),
        ...(v['content'] !== undefined
          ? { content: v['content'] as readonly AcpContentBlock[] }
          : {}),
      }
    }
    case 'plan': {
      const entries = v['entries']
      if (!Array.isArray(entries)) return null
      const parsed: { content: string; priority?: string }[] = []
      for (const e of entries) {
        if (!isObject(e) || typeof e['content'] !== 'string') return null
        if (e['priority'] !== undefined && typeof e['priority'] !== 'string') return null
        parsed.push({
          content: e['content'],
          ...(typeof e['priority'] === 'string' ? { priority: e['priority'] } : {}),
        })
      }
      return { sessionUpdate: 'plan', entries: parsed }
    }
    default:
      return null
  }
}

export function parseSessionUpdateParams(v: unknown): AcpSessionUpdateParams | null {
  if (!isObject(v)) return null
  if (typeof v['sessionId'] !== 'string') return null
  const update = parseSessionUpdate(v['update'])
  if (!update) return null
  return { sessionId: v['sessionId'], update }
}
