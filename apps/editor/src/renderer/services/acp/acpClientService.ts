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
 *  Notifications (currently only session/update) are forwarded verbatim to the
 *  caller-supplied sink so AcpSessionService can route them to the right
 *  Session instance by sessionId.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, ILoggerService, IFileService, URI } from '@universe-editor/platform'
import type { ILogger } from '@universe-editor/platform'
import { IAcpHostService } from '../../../shared/ipc/acpHostService.js'
import { AcpConnection, AcpRpcError, type IAcpConnectionHandler } from './acpConnection.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPermissionHandler } from './acpPermissionHandler.js'
import {
  AcpMethods,
  type AcpReadTextFileParams,
  type AcpReadTextFileResult,
  type AcpRequestPermissionParams,
  type AcpSessionUpdateParams,
  type AcpWriteTextFileParams,
} from './acpProtocol.js'
import { IOutputService } from '@universe-editor/platform'
import type { IOutputChannel } from '@universe-editor/platform'

export interface IAcpClientNotificationSink {
  onSessionUpdate(params: AcpSessionUpdateParams): void
}

export interface IAcpClientService {
  readonly _serviceBrand: undefined
  /**
   * Spawn the agent for `agentId` and return a wired AcpConnection. The
   * supplied sink receives forwarded `session/update` notifications.
   */
  connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<AcpConnection>
}

export const IAcpClientService = createDecorator<IAcpClientService>('acpClientService')

export class AcpClientService implements IAcpClientService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _stderrChannels = new Map<string, IOutputChannel>()

  constructor(
    @IAcpHostService private readonly _host: IAcpHostService,
    @IAcpAgentRegistry private readonly _registry: IAcpAgentRegistry,
    @IAcpPermissionHandler private readonly _permission: IAcpPermissionHandler,
    @IFileService private readonly _files: IFileService,
    @IOutputService private readonly _output: IOutputService,
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
    const { handle } = await this._host.start(spec)
    this._logger.info(`[acp] spawned agent=${agentId} handle=${handle}`)

    const stderr = this._getStderrChannel(agentId)
    const handler: IAcpConnectionHandler = {
      onRequest: (method, params) => this._handleRequest(method, params),
      onNotification: (method, params) => this._handleNotification(method, params, sink),
    }
    const conn = new AcpConnection(this._host, handle, handler, this._logger, (data) =>
      stderr.append(data),
    )
    return conn
  }

  private async _handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case AcpMethods.ReadTextFile: {
        const p = params as AcpReadTextFileParams
        const uri = URI.file(p.path)
        const content = await this._files.readFileText(uri)
        const sliced = sliceLines(content, p.line, p.limit)
        const result: AcpReadTextFileResult = { content: sliced }
        return result
      }
      case AcpMethods.WriteTextFile: {
        const p = params as AcpWriteTextFileParams
        await this._files.writeFile(URI.file(p.path), p.content)
        return null
      }
      case AcpMethods.RequestPermission: {
        const p = params as AcpRequestPermissionParams
        return await this._permission.request(p)
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
      sink.onSessionUpdate(params as AcpSessionUpdateParams)
      return
    }
    this._logger.warn(`[acp] ignoring unknown notification: ${method}`)
  }

  private _getStderrChannel(agentId: string): IOutputChannel {
    let chan = this._stderrChannels.get(agentId)
    if (!chan) {
      chan = this._output.createChannel(`acp/${agentId}`)
      this._stderrChannels.set(agentId, chan)
    }
    return chan
  }
}

function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content
  const lines = content.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}
