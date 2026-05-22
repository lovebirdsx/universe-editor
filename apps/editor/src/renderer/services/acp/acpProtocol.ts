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
