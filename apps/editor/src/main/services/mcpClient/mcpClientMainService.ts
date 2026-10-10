/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side MCP client — the only place the editor dials an MCP server itself,
 *  without an AI agent in between. Backs the "replay this tool call" debugger.
 *
 *  A connection is held open on purpose: listing tools, calling one, and reading
 *  why the server died all need an already-initialized session, and re-spawning
 *  per action would cost a handshake each time and lose the stderr tail. Entries
 *  are owned by the window that opened them (reclaimed on close/crash) and reaped
 *  after an idle TTL.
 *
 *  The stdio path spawns through a dedicated `AcpHostService` core instance rather
 *  than the app-wide `IAcpHostService` singleton: that singleton broadcasts every
 *  child's stdout to every window and tags processes as `acp-agent`, neither of
 *  which is right for an MCP server.
 *
 *  Nothing here ever logs a target or a stderr line verbatim — see mcpTargetSafety.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import {
  Disposable,
  Emitter,
  createNamedLogger,
  type Event,
  type ILogger,
  type ILoggerService,
} from '@universe-editor/platform'
import { AcpHostService } from '@universe-editor/node-services'
import type { AcpLaunchSpec } from '@universe-editor/platform'
import {
  Client,
  ErrorCode,
  McpError,
  UnauthorizedError,
  createHttpTransport,
  type McpTransport,
} from './mcpSdk.js'
import { McpStdioTransport, type McpStdioHost } from './mcpStdioTransport.js'
import { redactTargetForLog, stripSecretLike } from './mcpTargetSafety.js'
import { processRoleRegistry } from '../process/processRoleRegistry.js'
import type {
  IMcpClientService,
  McpCallResultDto,
  McpClientErrorCode,
  McpConnectResultDto,
  McpConnectTargetDto,
  McpConnectionClosedDto,
  McpStdioTargetDto,
  McpToolInfoDto,
} from '../../../shared/ipc/mcpClientService.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_IDLE_TTL_MS = 10 * 60_000
const CLIENT_NAME = 'universe-editor-mcp-debug'

interface ConnEntry {
  readonly id: string
  /** Owning window, or `undefined` when the connection is unscoped (tests). */
  readonly windowId: number | undefined
  readonly client: Client
  readonly transport: McpTransport
  readonly target: McpConnectTargetDto
  idleTimer: ReturnType<typeof setTimeout> | undefined
  closed: boolean
}

export interface McpClientMainServiceOptions {
  readonly clientVersion?: string
  readonly idleTtlMs?: number
  /** Injectable for tests: build the transport for a target (defaults to stdio/http/sse). */
  readonly createTransport?: (target: McpConnectTargetDto) => McpTransport
  /** Injectable for tests: the stdio process host backing the default transport. */
  readonly stdioHost?: McpStdioHost
}

export class McpClientMainService extends Disposable implements IMcpClientService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidCloseConnection = this._register(new Emitter<McpConnectionClosedDto>())
  readonly onDidCloseConnection: Event<McpConnectionClosedDto> = this._onDidCloseConnection.event

  private readonly _conns = new Map<string, ConnEntry>()
  private readonly _byWindow = new Map<number, Set<string>>()
  private readonly _logger: ILogger
  private readonly _clientVersion: string
  private readonly _idleTtlMs: number
  private readonly _createTransport: (target: McpConnectTargetDto) => McpTransport

  constructor(loggerService?: ILoggerService, options: McpClientMainServiceOptions = {}) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'mcpClient', name: 'MCP Client' })
    this._clientVersion = options.clientVersion ?? '1.0.0'
    this._idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    const host = options.stdioHost ?? this._register(createDefaultStdioHost(loggerService))
    this._createTransport =
      options.createTransport ??
      ((target) => {
        if (target.kind === 'stdio') return new McpStdioTransport(host, stdioLaunchSpec(target))
        return createHttpTransport(target.kind, target.url, target.headers)
      })
  }

  /**
   * Dial the target, run the MCP handshake and list its tools. The connection is
   * kept for later `listTools` / `callTool` until disconnected, reaped for idleness,
   * or its window goes away.
   *
   * `requestingWindowId` is main-internal (not on the wire contract, same shape as
   * `UpdateMainService.quitAndInstall`): it is how `createWindowScopedMcpClient`
   * stamps ownership so a renderer crash reclaims exactly that window's servers.
   */
  async connect(
    target: McpConnectTargetDto,
    timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
    requestingWindowId?: number,
  ): Promise<McpConnectResultDto> {
    const redacted = redactTargetForLog(target)
    this._logger.info(
      `connect ${target.kind} ${JSON.stringify(redacted)} windowId=${requestingWindowId ?? -1}`,
    )
    let transport: McpTransport | undefined
    let entry: ConnEntry | undefined
    try {
      transport = this._createTransport(target)
      const client = new Client(
        { name: CLIENT_NAME, version: this._clientVersion },
        { capabilities: {} },
      )
      const id = randomUUID()
      // Registered *before* the handshake: an entry that only appears once the
      // handshake succeeds is invisible to `stopAllForWindow`, so a window closed
      // mid-dial would leak the child until the idle TTL. `_watchClose` still waits
      // for success — until then a transport close rejects this very call instead.
      entry = {
        id,
        windowId: requestingWindowId,
        client,
        transport,
        target,
        idleTimer: undefined,
        closed: false,
      }
      this._conns.set(id, entry)
      this._linkWindow(entry)
      await withTimeout(client.connect(transport, { timeout: timeoutMs }), timeoutMs)
      const listed = await client.listTools(undefined, { timeout: timeoutMs })
      if (entry.closed) {
        // `stopAllForWindow` (window gone) or `disconnect` reclaimed it mid-handshake.
        throw codedError('MCP_UNKNOWN_CONNECTION', `MCP connection ${id} was reclaimed`)
      }
      this._watchClose(entry)
      this._touch(entry)
      const info = client.getServerVersion()
      const instructions = client.getInstructions()
      return {
        connectionId: id,
        serverName: info?.name ?? redacted.kind,
        serverVersion: info?.version ?? 'unknown',
        ...(instructions !== undefined ? { instructions } : {}),
        tools: listed.tools.map(toToolInfo),
      }
    } catch (err) {
      // Classify BEFORE tearing the transport down: closing it records an exit,
      // which would otherwise rewrite a timeout into "the server exited".
      const classified = this._classify(err, transport)
      if (entry) this._remove(entry)
      if (transport) await safeClose(transport)
      throw classified
    }
  }

  async listTools(
    connectionId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<McpToolInfoDto[]> {
    const entry = this._require(connectionId)
    this._touch(entry)
    try {
      const listed = await entry.client.listTools(undefined, { timeout: timeoutMs })
      return listed.tools.map(toToolInfo)
    } catch (err) {
      const classified = this._classify(err, entry.transport)
      this._reclaimIfUnusable(entry, classified)
      throw classified
    }
  }

  async callTool(
    connectionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<McpCallResultDto> {
    const entry = this._require(connectionId)
    this._touch(entry)
    const startedAt = Date.now()
    // A server that names an unknown tool replies with a normal `isError` result
    // (or a JSON-RPC error) — neither is an editor failure, so only transport-level
    // faults get an `MCP_*` code.
    const result = await entry.client
      .callTool({ name: tool, arguments: { ...args } }, undefined, { timeout: timeoutMs })
      .catch((err: unknown) => {
        const classified = this._classify(err, entry.transport)
        this._reclaimIfUnusable(entry, classified)
        throw classified
      })
    return {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content : [],
      ...('structuredContent' in result && result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      durationMs: Date.now() - startedAt,
    }
  }

  /** Explicit teardown — never fires `onDidCloseConnection` (nothing ended on its own). */
  async disconnect(connectionId: string): Promise<void> {
    const entry = this._conns.get(connectionId)
    if (!entry) return
    await this._drop(entry, 'disconnected')
  }

  /** Reclaim every connection a window opened (renderer crash / window close). */
  async stopAllForWindow(windowId: number): Promise<void> {
    const ids = [...(this._byWindow.get(windowId) ?? [])]
    for (const id of ids) {
      const entry = this._conns.get(id)
      if (entry) await this._drop(entry, 'disconnected')
    }
    if (ids.length > 0) {
      this._logger.info(`stopAllForWindow windowId=${windowId} closed=${ids.length}`)
    }
  }

  override dispose(): void {
    for (const entry of [...this._conns.values()]) {
      this._clearTimer(entry)
      entry.closed = true
      void safeClose(entry.transport)
    }
    this._conns.clear()
    this._byWindow.clear()
    super.dispose()
  }

  /** Route a transport-initiated close (server exit / transport fault) to the event. */
  private _watchClose(entry: ConnEntry): void {
    const transport = entry.transport
    const previous = transport.onclose
    transport.onclose = () => {
      previous?.()
      if (entry.closed) return
      const exit = transport instanceof McpStdioTransport ? transport.exit : undefined
      const reason: McpConnectionClosedDto['reason'] =
        exit?.kind === 'spawn-failed' ? 'transport-error' : 'server-exit'
      const detail = exit?.detail
      this._logger.warn(
        `connection closed id=${entry.id} reason=${reason} ${detail !== undefined ? `detail=${detail}` : ''}`,
      )
      this._remove(entry)
      this._onDidCloseConnection.fire({
        connectionId: entry.id,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      })
    }
  }

  private _require(connectionId: string): ConnEntry {
    const entry = this._conns.get(connectionId)
    if (!entry || entry.closed) {
      throw codedError(
        'MCP_UNKNOWN_CONNECTION',
        `MCP connection ${connectionId} is not open (it may have exited — reconnect)`,
      )
    }
    return entry
  }

  private _touch(entry: ConnEntry): void {
    this._clearTimer(entry)
    if (this._idleTtlMs <= 0) return
    const timer = setTimeout(() => {
      void this._reap(entry.id)
    }, this._idleTtlMs)
    // Node keeps the event loop alive for pending timers; a debugger connection
    // must never hold the app open.
    timer.unref?.()
    entry.idleTimer = timer
  }

  private _clearTimer(entry: ConnEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private async _reap(connectionId: string): Promise<void> {
    const entry = this._conns.get(connectionId)
    if (!entry) return
    this._logger.info(`idle reap id=${connectionId} (ttl ${this._idleTtlMs}ms)`)
    // Unlink BEFORE closing: the close fires the transport's own `onclose`, and the
    // `_watchClose` relay must see the entry as already gone (it is not a server exit).
    this._remove(entry)
    await safeClose(entry.transport)
    this._onDidCloseConnection.fire({ connectionId, reason: 'idle' })
  }

  private async _drop(entry: ConnEntry, reason: McpConnectionClosedDto['reason']): Promise<void> {
    if (entry.closed) return
    this._remove(entry)
    await safeClose(entry.transport)
    this._logger.info(`disconnect id=${entry.id} reason=${reason}`)
  }

  private _remove(entry: ConnEntry): void {
    if (entry.closed) return
    entry.closed = true
    this._clearTimer(entry)
    this._conns.delete(entry.id)
    if (entry.windowId !== undefined) {
      const set = this._byWindow.get(entry.windowId)
      set?.delete(entry.id)
      if (set?.size === 0) this._byWindow.delete(entry.windowId)
    }
  }

  private _classify(err: unknown, transport: McpTransport | undefined): Error {
    // Already classified (our own outer timeout, or a rethrow from a nested call).
    if (isMcpClientErrorCode((err as { code?: unknown } | undefined)?.code)) return err as Error
    if (err instanceof UnauthorizedError) {
      return codedError(
        'MCP_NEEDS_AUTH',
        'MCP server requires an interactive login, which the replay debugger cannot perform',
      )
    }
    // Checked before the exit branch: failing the protocol closes the transport, and
    // that close records an exit that would otherwise mask the real reason.
    if (transport instanceof McpStdioTransport && transport.protocolError !== undefined) {
      return codedError('MCP_PROTOCOL_ERROR', stripSecretLike(transport.protocolError))
    }
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      return codedError('MCP_TIMEOUT', `MCP server did not answer in time: ${err.message}`)
    }
    if (transport instanceof McpStdioTransport) {
      const exit = transport.exit
      if (exit?.kind === 'spawn-failed') {
        return codedError(
          'MCP_SPAWN_FAILED',
          `Could not start the MCP server process: ${exit.detail ?? 'unknown spawn error'}`,
        )
      }
      if (exit !== undefined) {
        return codedError(
          'MCP_CONNECT_FAILED',
          `MCP server exited (code ${exit.code})` +
            (exit.detail !== undefined ? `\n${exit.detail}` : ''),
        )
      }
    }
    if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
      return codedError('MCP_CONNECT_FAILED', `MCP connection closed: ${safeMessage(err)}`)
    }
    // A JSON-RPC error reply: the server understood the request and refused it. Its
    // own words are the message — nothing here is an editor or framing fault.
    if (err instanceof McpError || isJsonRpcShaped(err)) {
      return codedError('MCP_SERVER_ERROR', safeMessage(err))
    }
    return codedError('MCP_CONNECT_FAILED', safeMessage(err))
  }

  /**
   * Drop a connection whose failure says the link itself is gone (transport fault,
   * protocol violation) rather than "the server said no". The SDK's http/sse
   * transports never fire `onclose` on a dropped stream, so without this the panel
   * would keep showing "connected" and fail every Run until the user noticed.
   */
  private _reclaimIfUnusable(entry: ConnEntry, err: Error): void {
    const code = (err as { code?: unknown }).code
    if (code !== 'MCP_CONNECT_FAILED' && code !== 'MCP_PROTOCOL_ERROR') return
    if (entry.closed) return
    this._logger.warn(`connection unusable id=${entry.id} code=${String(code)} — reclaiming`)
    this._remove(entry)
    void safeClose(entry.transport)
    this._onDidCloseConnection.fire({
      connectionId: entry.id,
      reason: 'transport-error',
      detail: err.message,
    })
  }

  private _linkWindow(entry: ConnEntry): void {
    if (entry.windowId === undefined) return
    let set = this._byWindow.get(entry.windowId)
    if (!set) {
      set = new Set()
      this._byWindow.set(entry.windowId, set)
    }
    set.add(entry.id)
  }
}

/**
 * Without a logger service `AcpHostService` falls back to `NullLogger`, whose own
 * disposables are parentless — the dev leak tracker reports them on every exit.
 */
function createDefaultStdioHost(loggerService: ILoggerService | undefined): AcpHostService {
  return new AcpHostService({
    ...(loggerService !== undefined ? { logger: loggerService } : {}),
    onSpawned: (pid, label) => processRoleRegistry.register(pid, { role: 'mcp-server', label }),
  })
}

function stdioLaunchSpec(target: McpStdioTargetDto): AcpLaunchSpec {
  return {
    command: target.command,
    args: [...target.args],
    ...(target.env !== undefined ? { env: { ...target.env } } : {}),
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  }
}

function toToolInfo(tool: {
  name: string
  title?: string | undefined
  description?: string | undefined
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: { title?: string | undefined } | undefined
}): McpToolInfoDto {
  // `title` moved to the top level in the 2025-06-18 spec; `annotations.title` is
  // the pre-move location and still what older servers send.
  const title = tool.title ?? tool.annotations?.title
  return {
    name: tool.name,
    ...(title !== undefined ? { title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
  }
}

function codedError(code: McpClientErrorCode, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { code: string }).code = code
  return err
}

function isJsonRpcShaped(err: unknown): boolean {
  return typeof (err as { code?: unknown } | undefined)?.code === 'number'
}

/**
 * Server-controlled text (a JSON-RPC error message, a protocol violation) may quote
 * the server's own configuration back at us — it goes through the same masker as the
 * stderr tail before it reaches a log line, the panel, or the copy button.
 */
function safeMessage(err: unknown): string {
  const raw = (err as { message?: unknown } | undefined)?.message
  const text = typeof raw === 'string' && raw.length > 0 ? raw : String(err)
  return stripSecretLike(text)
}

const MCP_CLIENT_ERROR_CODES: readonly McpClientErrorCode[] = [
  'MCP_SPAWN_FAILED',
  'MCP_CONNECT_FAILED',
  'MCP_TIMEOUT',
  'MCP_NEEDS_AUTH',
  'MCP_SERVER_ERROR',
  'MCP_PROTOCOL_ERROR',
  'MCP_UNKNOWN_CONNECTION',
]

function isMcpClientErrorCode(value: unknown): value is McpClientErrorCode {
  return typeof value === 'string' && (MCP_CLIENT_ERROR_CODES as readonly string[]).includes(value)
}

async function safeClose(transport: McpTransport): Promise<void> {
  try {
    await transport.close()
  } catch {
    // Closing a transport that already died is routine.
  }
}

/**
 * Race a promise against a timer. `timeoutMs <= 0` disables the guard (tests use it
 * to exercise the SDK's own timeout path).
 */
function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return value
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The losing side keeps running; swallow whatever it eventually settles with
      // so a late rejection does not surface as an unhandled promise rejection.
      value.catch(() => undefined)
      reject(codedError('MCP_TIMEOUT', `MCP server did not answer within ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    value.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err as Error)
      },
    )
  })
}

/**
 * Bind the application MCP client singleton to the BrowserWindow serving one IPC
 * channel, stamping the windowId onto every `connect` so a crash reclaims exactly
 * that window's servers (mirrors createWindowScopedAcpHost).
 */
export function createWindowScopedMcpClient(
  service: McpClientMainService,
  windowId: number,
): IMcpClientService {
  return {
    _serviceBrand: undefined,
    onDidCloseConnection: service.onDidCloseConnection,
    connect: (target, timeoutMs) => service.connect(target, timeoutMs, windowId),
    listTools: (connectionId, timeoutMs) => service.listTools(connectionId, timeoutMs),
    callTool: (connectionId, tool, args, timeoutMs) =>
      service.callTool(connectionId, tool, args, timeoutMs),
    disconnect: (connectionId) => service.disconnect(connectionId),
  }
}
