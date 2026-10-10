/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the editor-side MCP client — the transport-agnostic channel the
 *  MCP tool debugger uses to call a tool without going through an AI agent.
 *
 *  ACP has no "client initiates a tool call" method: both agent forks execute tools
 *  inside their own process (the ACP `fs/*` / `terminal/*` callbacks are dead code
 *  there since upstream switched to built-in tools). Replaying an MCP tool call
 *  therefore means the editor connects to the server itself, which is what this
 *  service does.
 *
 *  Split of responsibilities: the renderer resolves the *configuration* (it owns the
 *  layered settings / agent-config reads) and hands over a target; main owns every
 *  side-effecting act — spawning the stdio server, dialing http/sse, holding the live
 *  connection. `env` / `headers` cross the boundary exactly as they already do on the
 *  ACP `session/new` path, and never reach a log line.
 *
 *  Path convention: `McpStdioTargetDto.cwd` is a *string* native path, NOT a URI —
 *  the same documented exception as `AcpLaunchSpec.cwd` (see remoteProtocol.ts). The
 *  renderer passes the session's cwd verbatim so relative args (`"."`) resolve the
 *  way the agent saw them.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export interface McpStdioTargetDto {
  readonly kind: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** Absolute host path used as the child's working directory. */
  readonly cwd?: string
}

export interface McpHttpTargetDto {
  readonly kind: 'http' | 'sse'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export type McpConnectTargetDto = McpStdioTargetDto | McpHttpTargetDto

export interface McpToolInfoDto {
  readonly name: string
  readonly title?: string
  readonly description?: string
  /** JSON Schema of the tool's arguments (opaque here — the panel renders it as JSON). */
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
}

export interface McpConnectResultDto {
  readonly connectionId: string
  /** Server-reported implementation name / version (`InitializeResult.serverInfo`). */
  readonly serverName: string
  readonly serverVersion: string
  /** Optional server instructions, shown once in the panel. */
  readonly instructions?: string
  readonly tools: readonly McpToolInfoDto[]
}

export interface McpCallResultDto {
  /** The MCP-level `isError` flag — a *normal* server reply, never an editor failure. */
  readonly isError: boolean
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly durationMs: number
}

export interface McpConnectionClosedDto {
  readonly connectionId: string
  readonly reason: 'server-exit' | 'idle' | 'disconnected' | 'transport-error'
  /** Human-readable detail; for `server-exit` this carries the stderr tail. */
  readonly detail?: string
}

/**
 * Machine-readable failure codes; they ride the IPC error envelope's `err.code`.
 *
 * `MCP_SERVER_ERROR` vs `MCP_PROTOCOL_ERROR` is the line between "the server spoke
 * MCP and said no" (unknown tool, bad arguments — the server's own message is the
 * whole story) and "what came back was not MCP at all".
 */
export type McpClientErrorCode =
  | 'MCP_SPAWN_FAILED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_NEEDS_AUTH'
  | 'MCP_SERVER_ERROR'
  | 'MCP_PROTOCOL_ERROR'
  | 'MCP_UNKNOWN_CONNECTION'

export interface IMcpClientService {
  readonly _serviceBrand: undefined
  /** Fires when a held connection ends on its own (server exit / idle reap). */
  readonly onDidCloseConnection: Event<McpConnectionClosedDto>
  /**
   * Spawn / dial the target, run the MCP handshake, and list its tools. The
   * connection stays alive for later `listTools` / `callTool` calls until it is
   * disconnected, reaped for idleness, or its window goes away.
   */
  connect(target: McpConnectTargetDto, timeoutMs?: number): Promise<McpConnectResultDto>
  listTools(connectionId: string, timeoutMs?: number): Promise<readonly McpToolInfoDto[]>
  callTool(
    connectionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<McpCallResultDto>
  disconnect(connectionId: string): Promise<void>
}

export const IMcpClientService = createDecorator<IMcpClientService>('mcpClientService')
