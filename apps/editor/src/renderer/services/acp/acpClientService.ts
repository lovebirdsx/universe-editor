/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpClientService — boots an ACP agent and returns a wired AcpConnection.
 *
 *  The Client side of ACP must answer three peer-initiated request methods:
 *    - fs/read_text_file  → IFileService.readFileText
 *    - fs/write_text_file → IFileService.writeFile
 *    - session/request_permission → IAcpPermissionHandler.request
 *  All other peer methods return JSON-RPC error -32601 (Method not found).
 *
 *  All fs/* requests are gated through IAcpPathPolicy against the session cwd
 *  the caller supplied. Anything outside the cwd or under a sensitive prefix
 *  fails closed with -32602 Invalid params and surfaces a user-visible
 *  notification — the agent process is untrusted code.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  ILoggerService,
  IFileService,
  INotificationService,
  ITelemetryService,
  Severity,
  URI,
} from '@universe-editor/platform'
import type { ILogger } from '@universe-editor/platform'
import { IAcpHostService } from '../../../shared/ipc/acpHostService.js'
import { AcpConnection, AcpRpcError, type IAcpConnectionHandler } from './acpConnection.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPathPolicy } from './acpPathPolicy.js'
import {
  AcpMethods,
  parseReadTextFileParams,
  parseRequestPermissionParams,
  parseWriteTextFileParams,
  type AcpReadTextFileResult,
  type AcpRequestPermissionResult,
  type AcpSessionUpdateParams,
} from './acpProtocol.js'
import { IOutputService } from '@universe-editor/platform'

export interface IAcpClientNotificationSink {
  onSessionUpdate(params: AcpSessionUpdateParams): void
  /**
   * Peer-initiated `session/request_permission`. The sink owns the UX
   * (inline-in-chat card today) and the autoApprove short-circuit.
   */
  onRequestPermission(
    params: import('./acpProtocol.js').AcpRequestPermissionParams,
  ): Promise<AcpRequestPermissionResult>
}

export interface IAcpClientService {
  readonly _serviceBrand: undefined
  /**
   * Spawn the agent for `agentId` and return a wired AcpConnection. The
   * supplied sink receives forwarded `session/update` notifications. The
   * `cwd` option doubles as the path-sandbox root for fs/* peer requests.
   */
  connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<AcpConnection>
}

export const IAcpClientService = createDecorator<IAcpClientService>('acpClientService')

const JSONRPC_INVALID_PARAMS = -32602

export class AcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IAcpHostService private readonly _host: IAcpHostService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IAcpPathPolicy private readonly _pathPolicy: IAcpPathPolicy,
    @IFileService private readonly _files: IFileService,
    @IOutputService private readonly _output: IOutputService,
    @INotificationService private readonly _notification: INotificationService,
    @ITelemetryService private readonly _telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = loggerService.createLogger({ id: 'acpClient', name: 'ACP Client' })
  }

  async connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<AcpConnection> {
    const spec = this._registry.resolve(agentId, options?.cwd)
    let handle: string
    try {
      handle = (await this._host.start(spec)).handle
    } catch (err) {
      this._telemetry.publicLogError('acp.spawn_failed', {
        agentId,
        error: (err as Error).message,
      })
      this._notification.notify({
        severity: Severity.Error,
        message: `Failed to start agent "${agentId}": ${(err as Error).message}`,
      })
      throw err
    }
    this._logger.info(`[acp] spawned agent=${agentId} handle=${handle}`)
    this._telemetry.publicLog('acp.spawned', { agentId })

    const cwd = options?.cwd ?? ''
    const stderr = this._output.createChannel(`acp/${agentId}/${handle}`)
    const handler: IAcpConnectionHandler = {
      onRequest: (method, params) => this._handleRequest(method, params, cwd, sink),
      onNotification: (method, params) => this._handleNotification(method, params, sink),
    }
    const conn = new AcpConnection(this._host, handle, handler, this._logger, (data) =>
      stderr.append(data),
    )
    conn.onExit(() => {
      try {
        stderr.dispose()
      } catch {
        // OutputChannel.dispose is idempotent; swallow if already gone.
      }
    })
    return conn
  }

  private async _handleRequest(
    method: string,
    params: unknown,
    cwd: string,
    sink: IAcpClientNotificationSink,
  ): Promise<unknown> {
    switch (method) {
      case AcpMethods.ReadTextFile: {
        const p = parseReadTextFileParams(params)
        if (!p)
          throw new AcpRpcError('Invalid params for fs/read_text_file', JSONRPC_INVALID_PARAMS)
        const decision = this._pathPolicy.check(cwd, p.path)
        if (!decision.ok) {
          this._reportBlockedPath('read', p.path, decision.reason)
          throw new AcpRpcError(
            `fs/read_text_file rejected: ${decision.reason}`,
            JSONRPC_INVALID_PARAMS,
          )
        }
        const uri = URI.file(decision.normalized)
        const content = await this._files.readFileText(uri)
        const sliced = sliceLines(content, p.line, p.limit)
        const result: AcpReadTextFileResult = { content: sliced }
        return result
      }
      case AcpMethods.WriteTextFile: {
        const p = parseWriteTextFileParams(params)
        if (!p)
          throw new AcpRpcError('Invalid params for fs/write_text_file', JSONRPC_INVALID_PARAMS)
        const decision = this._pathPolicy.check(cwd, p.path)
        if (!decision.ok) {
          this._reportBlockedPath('write', p.path, decision.reason)
          throw new AcpRpcError(
            `fs/write_text_file rejected: ${decision.reason}`,
            JSONRPC_INVALID_PARAMS,
          )
        }
        await this._files.writeFile(URI.file(decision.normalized), p.content)
        return null
      }
      case AcpMethods.RequestPermission: {
        const p = parseRequestPermissionParams(params)
        if (!p) {
          throw new AcpRpcError(
            'Invalid params for session/request_permission',
            JSONRPC_INVALID_PARAMS,
          )
        }
        return await sink.onRequestPermission(p)
      }
      default:
        throw new AcpRpcError(`Method not found: ${method}`, AcpRpcError.METHOD_NOT_FOUND)
    }
  }

  private _handleNotification(
    method: string,
    params: unknown,
    sink: IAcpClientNotificationSink,
  ): void {
    if (method === AcpMethods.SessionUpdate) {
      // Validation lives in AcpSessionService where the per-session router
      // already knows how to gracefully ignore unknown update kinds.
      sink.onSessionUpdate(params as AcpSessionUpdateParams)
      return
    }
    this._logger.warn(`[acp] ignoring unknown notification: ${method}`)
  }

  private _reportBlockedPath(op: 'read' | 'write', path: string, reason: string): void {
    this._logger.warn(`[acp] blocked agent fs/${op}: ${path} (${reason})`)
    this._telemetry.publicLog('acp.path_blocked', { op, reason })
    this._notification.notify({
      severity: Severity.Warning,
      message: `Agent's request to ${op} "${path}" was blocked: ${reason}`,
    })
  }
}

function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content
  const lines = content.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}
