/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpClientService — boots an ACP agent and returns a wired ClientSideConnection
 *  from `@agentclientprotocol/sdk`.
 *
 *  The Client side of ACP answers peer-initiated requests by implementing the
 *  SDK's `Client` interface (readTextFile / writeTextFile / requestPermission /
 *  the five terminal methods) plus the `sessionUpdate` notification handler.
 *  Everything else (unstable_*, extMethod, extNotification) is left undefined so
 *  the SDK returns `Method not found` automatically.
 *
 *  All fs/* requests are gated through IAcpPathPolicy against the session cwd
 *  the caller supplied. Anything outside the cwd or under a sensitive prefix
 *  fails closed with `RequestError.invalidParams` and surfaces a user-visible
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
import {
  ClientSideConnection,
  RequestError,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { IAcpHostService } from '../../../shared/ipc/acpHostService.js'
import { IAcpTerminalService } from '../../../shared/ipc/acpTerminalService.js'
import { IAcpAgentRegistry } from './acpAgentRegistry.js'
import { IAcpPathPolicy } from './acpPathPolicy.js'
import { createSdkHostStream } from './sdkHostStream.js'
import { IOutputService } from '@universe-editor/platform'

export interface IAcpClientNotificationSink {
  onSessionUpdate(params: SessionNotification): void
  /**
   * Peer-initiated `session/request_permission`. The sink owns the UX
   * (inline-in-chat card today) and the autoApprove short-circuit.
   */
  onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
}

export interface IAcpClientConnection {
  readonly conn: ClientSideConnection
  /** Stop the agent process and detach all listeners. Idempotent. */
  dispose(): void
}

export interface IAcpClientService {
  readonly _serviceBrand: undefined
  /**
   * Spawn the agent for `agentId` and return a wired ClientSideConnection.
   * The supplied sink receives forwarded `session/update` notifications and
   * `session/request_permission` requests. The `cwd` option doubles as the
   * path-sandbox root for fs/* peer requests.
   */
  connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<IAcpClientConnection>
}

export const IAcpClientService = createDecorator<IAcpClientService>('acpClientService')

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
    @IAcpTerminalService private readonly _terminals: IAcpTerminalService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = loggerService.createLogger({ id: 'acpClient', name: 'ACP Client' })
  }

  async connect(
    agentId: string,
    sink: IAcpClientNotificationSink,
    options?: { cwd?: string },
  ): Promise<IAcpClientConnection> {
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
    const stderrSub = this._host.onStderr((chunk) => {
      if (chunk.handle === handle) stderr.append(chunk.data)
    })
    // Per-connection registry of terminals the agent has opened. Tracked
    // here so we can both (a) reject cross-connection terminalId references
    // and (b) reap leftover terminals if the agent crashes without releasing.
    const ownedTerminals = new Set<string>()

    const clientImpl: Client = {
      requestPermission: (params) => sink.onRequestPermission(params),
      sessionUpdate: async (params) => {
        sink.onSessionUpdate(params)
      },
      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        const decision = this._pathPolicy.check(cwd, params.path)
        if (!decision.ok) {
          this._reportBlockedPath('read', params.path, decision.reason)
          throw RequestError.invalidParams(
            undefined,
            `fs/read_text_file rejected: ${decision.reason}`,
          )
        }
        const uri = URI.file(decision.normalized)
        const content = await this._files.readFileText(uri)
        const sliced = sliceLines(content, params.line ?? undefined, params.limit ?? undefined)
        return { content: sliced }
      },
      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        const decision = this._pathPolicy.check(cwd, params.path)
        if (!decision.ok) {
          this._reportBlockedPath('write', params.path, decision.reason)
          throw RequestError.invalidParams(
            undefined,
            `fs/write_text_file rejected: ${decision.reason}`,
          )
        }
        await this._files.writeFile(URI.file(decision.normalized), params.content)
        return {}
      },
      createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
        // path-policy gating: rewrite cwd to its normalized form so the agent
        // can't smuggle `..` segments past the sandbox check.
        const { sessionId: _sessionId, ...rest } = params
        let spec: Omit<CreateTerminalRequest, 'sessionId'> = rest
        if (params.cwd != null) {
          const decision = this._pathPolicy.check(cwd, params.cwd)
          if (!decision.ok) {
            this._reportBlockedPath('terminal-cwd', params.cwd, decision.reason)
            throw RequestError.invalidParams(
              undefined,
              `terminal/create rejected: ${decision.reason}`,
            )
          }
          spec = { ...rest, cwd: decision.normalized }
        }
        const created = await this._terminals.create(spec)
        ownedTerminals.add(created.terminalId)
        this._telemetry.publicLog('acp.terminal_created', { command: params.command })
        return created
      },
      terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        assertTerminalOwned(ownedTerminals, params.terminalId)
        return this._terminals.output(params.terminalId)
      },
      waitForTerminalExit: async (
        params: WaitForTerminalExitRequest,
      ): Promise<WaitForTerminalExitResponse> => {
        assertTerminalOwned(ownedTerminals, params.terminalId)
        return this._terminals.waitForExit(params.terminalId)
      },
      killTerminal: async (params: KillTerminalRequest) => {
        assertTerminalOwned(ownedTerminals, params.terminalId)
        await this._terminals.kill(params.terminalId)
      },
      releaseTerminal: async (params: ReleaseTerminalRequest) => {
        assertTerminalOwned(ownedTerminals, params.terminalId)
        ownedTerminals.delete(params.terminalId)
        await this._terminals.release(params.terminalId)
      },
    }

    const hostStream = createSdkHostStream(this._host, handle)
    const conn = new ClientSideConnection(() => clientImpl, hostStream.stream)

    let disposed = false
    const cleanup = (): void => {
      if (disposed) return
      disposed = true
      stderrSub.dispose()
      try {
        stderr.dispose()
      } catch {
        // OutputChannel.dispose is idempotent; swallow if already gone.
      }
      hostStream.dispose()
      // Reap terminals the agent left dangling. `release` kills the proc if
      // still alive; we swallow errors because the process may be racing exit.
      if (ownedTerminals.size > 0) {
        const ids = [...ownedTerminals]
        ownedTerminals.clear()
        for (const id of ids) {
          void this._terminals.release(id).catch(() => {
            // best-effort
          })
        }
      }
    }

    // Connection closes when the underlying stream ends (host exits or stop is
    // called). Use the SDK's abort signal as the canonical "connection done"
    // hook — it fires before `closed` resolves.
    conn.signal.addEventListener('abort', cleanup, { once: true })

    return {
      conn,
      dispose: (): void => {
        // Manual dispose: kill the agent process if alive. The host's onExit
        // will propagate into the SDK stream and fire `signal.abort`, which
        // triggers `cleanup` above. Calling `cleanup` here too keeps things
        // idempotent if `stop` rejects or races.
        void this._host.stop(handle).catch(() => {
          // best-effort
        })
        cleanup()
      },
    }
  }

  private _reportBlockedPath(
    op: 'read' | 'write' | 'terminal-cwd',
    path: string,
    reason: string,
  ): void {
    this._logger.warn(`[acp] blocked agent fs/${op}: ${path} (${reason})`)
    this._telemetry.publicLog('acp.path_blocked', { op, reason })
    this._notification.notify({
      severity: Severity.Warning,
      message: `Agent's request to ${op} "${path}" was blocked: ${reason}`,
    })
  }
}

function assertTerminalOwned(owned: Set<string>, terminalId: string): void {
  if (!owned.has(terminalId)) {
    throw RequestError.invalidParams(undefined, `Unknown terminal: ${terminalId}`)
  }
}

function sliceLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return content
  const lines = content.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}
