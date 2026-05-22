/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  JSON-RPC 2.0 client over the AcpHost byte-stream IPC. Frames are newline-
 *  delimited (each message is a JSON object terminated by `\n`).
 *
 *  Bidirectional: both endpoints may issue requests, so we expose `request`,
 *  `notify`, and an inbound handler the caller registers for peer-initiated
 *  traffic. The connection multiplexes requests by JSON-RPC `id`.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, type IDisposable, type ILogger } from '@universe-editor/platform'
import type {
  IAcpHostService,
  AcpExitEvent,
  AcpStdioChunk,
} from '../../../shared/ipc/acpHostService.js'
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './acpProtocol.js'

export interface IAcpConnectionHandler {
  /**
   * Handle a peer-initiated request. Throw to send a JSON-RPC error back.
   */
  onRequest(method: string, params: unknown): Promise<unknown>
  /**
   * Handle a peer-initiated notification. Errors are logged but not propagated.
   */
  onNotification(method: string, params: unknown): void
}

interface PendingCall {
  resolve(value: unknown): void
  reject(err: Error): void
}

const JSONRPC_ERROR_METHOD_NOT_FOUND = -32601
const JSONRPC_ERROR_INTERNAL = -32603

/**
 * Bidirectional ACP connection. One instance corresponds to one agent process
 * and one IAcpHostService handle. Dispose to detach listeners and kill the
 * process via the host service.
 */
export class AcpConnection extends Disposable {
  private readonly _onExit = this._register(new Emitter<AcpExitEvent>())
  readonly onExit = this._onExit.event

  private _buffer = ''
  private _nextId = 1
  private readonly _pending = new Map<JsonRpcId, PendingCall>()
  private _disposed = false
  /** Rolling tail of agent stderr — used to enrich exit failure messages. */
  private _stderrTail = ''
  private static readonly STDERR_TAIL_LIMIT = 2000

  constructor(
    private readonly _host: IAcpHostService,
    private readonly _handle: string,
    private readonly _handler: IAcpConnectionHandler,
    private readonly _logger: ILogger,
    /** stderr sink — receives the raw text chunks. */
    private readonly _onStderr?: (data: string) => void,
  ) {
    super()
    this._register(
      this._host.onStdout((chunk: AcpStdioChunk) => {
        if (chunk.handle !== this._handle) return
        this._ingest(chunk.data)
      }),
    )
    this._register(
      this._host.onStderr((chunk: AcpStdioChunk) => {
        if (chunk.handle !== this._handle) return
        const next = this._stderrTail + chunk.data
        this._stderrTail =
          next.length > AcpConnection.STDERR_TAIL_LIMIT
            ? next.slice(-AcpConnection.STDERR_TAIL_LIMIT)
            : next
        this._onStderr?.(chunk.data)
      }),
    )
    this._register(
      this._host.onExit((evt: AcpExitEvent) => {
        if (evt.handle !== this._handle) return
        const base = evt.error
          ? `Agent failed to start: ${evt.error}`
          : `Agent exited (code=${evt.code ?? 'null'} signal=${evt.signal ?? 'null'})`
        const tail = this._stderrTail.trim()
        const reason = tail ? `${base}\nstderr:\n${tail}` : base
        this._failPending(new Error(reason))
        this._onExit.fire(evt)
      }),
    )
  }

  /**
   * Issue a JSON-RPC request and resolve with the result (or reject on error).
   * Pass an AbortSignal to settle the promise locally — note that the peer is
   * NOT notified; cancel semantics on the wire are protocol-specific.
   */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this._disposed) {
      return Promise.reject(new Error('AcpConnection: disposed'))
    }
    if (signal?.aborted) {
      return Promise.reject(new AcpAbortError(method))
    }
    const id = this._nextId++
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this._pending.has(id)) return
        this._pending.delete(id)
        reject(new AcpAbortError(method))
      }
      this._pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(v as T)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this._send(msg).catch((err: Error) => {
        this._pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
    })
  }

  /** Fire-and-forget JSON-RPC notification. */
  notify(method: string, params?: unknown): Promise<void> {
    if (this._disposed) return Promise.resolve()
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    return this._send(msg)
  }

  private _send(msg: JsonRpcMessage): Promise<void> {
    const line = JSON.stringify(msg) + '\n'
    return this._host.writeStdin(this._handle, line)
  }

  private _ingest(chunk: string): void {
    this._buffer += chunk
    while (true) {
      const nl = this._buffer.indexOf('\n')
      if (nl === -1) break
      const line = this._buffer.slice(0, nl).trim()
      this._buffer = this._buffer.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcMessage
        this._dispatch(msg)
      } catch (err) {
        this._logger.warn(`[acp] failed to parse line: ${(err as Error).message}: ${line}`)
      }
    }
  }

  private _dispatch(msg: JsonRpcMessage): void {
    // Response to an outbound request?
    if ('id' in msg && msg.id !== undefined && !('method' in msg)) {
      const resp = msg as JsonRpcResponse
      const pending = this._pending.get(resp.id)
      if (!pending) {
        this._logger.warn(`[acp] response with unknown id ${String(resp.id)}`)
        return
      }
      this._pending.delete(resp.id)
      if (resp.error) {
        pending.reject(new AcpRpcError(resp.error.message, resp.error.code, resp.error.data))
      } else {
        pending.resolve(resp.result)
      }
      return
    }
    // Peer-initiated request?
    if ('method' in msg && 'id' in msg && msg.id !== undefined && msg.id !== null) {
      const req = msg as JsonRpcRequest
      void this._handlePeerRequest(req)
      return
    }
    // Notification.
    if ('method' in msg) {
      const note = msg as JsonRpcNotification
      try {
        this._handler.onNotification(note.method, note.params)
      } catch (err) {
        this._logger.warn(
          `[acp] notification handler threw method=${note.method}: ${(err as Error).message}`,
        )
      }
      return
    }
    this._logger.warn(`[acp] unknown message shape: ${JSON.stringify(msg)}`)
  }

  private async _handlePeerRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this._handler.onRequest(req.method, req.params)
      const resp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: req.id,
        result: result ?? null,
      }
      await this._send(resp)
    } catch (err) {
      const code = err instanceof AcpRpcError ? err.code : JSONRPC_ERROR_INTERNAL
      const message = err instanceof Error ? err.message : String(err)
      const resp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: req.id,
        error: { code, message },
      }
      await this._send(resp).catch(() => {})
    }
  }

  private _failPending(err: Error): void {
    for (const p of this._pending.values()) p.reject(err)
    this._pending.clear()
  }

  /**
   * Kill the underlying process and detach listeners. Pending requests reject
   * with a "disposed" error.
   */
  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._failPending(new Error('AcpConnection: disposed'))
    void this._host.stop(this._handle).catch(() => {})
    super.dispose()
  }
}

export class AcpRpcError extends Error {
  static readonly METHOD_NOT_FOUND = JSONRPC_ERROR_METHOD_NOT_FOUND
  static readonly INTERNAL_ERROR = JSONRPC_ERROR_INTERNAL

  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

export class AcpAbortError extends Error {
  constructor(method: string) {
    super(`Aborted: ${method}`)
    this.name = 'AcpAbortError'
  }
}

/**
 * Test/utility transport: pure in-memory pipe that lets you drive an
 * AcpConnection without spawning a real process. Returns the connection + a
 * handle to inject inbound bytes and observe outbound writes.
 */
export interface IAcpTransportTestHarness extends IDisposable {
  readonly host: IAcpHostService
  readonly handle: string
  /** Feed bytes as if they came from the agent's stdout. */
  inject(data: string): void
  /** Feed bytes as if they came from the agent's stderr. */
  injectStderr(data: string): void
  /** Snapshot of everything written to stdin so far. */
  written(): readonly string[]
  /** Emit a synthetic exit event. */
  exit(code: number | null, signal: string | null): void
  /** Emit a synthetic exit triggered by a spawn-time failure. */
  exitWithError(error: string): void
}

export function createInMemoryAcpHost(): IAcpTransportTestHarness {
  const onStdout = new Emitter<AcpStdioChunk>()
  const onStderr = new Emitter<AcpStdioChunk>()
  const onExit = new Emitter<AcpExitEvent>()
  const handle = 'mem-' + Math.random().toString(36).slice(2, 10)
  const writes: string[] = []
  const host: IAcpHostService = {
    _serviceBrand: undefined,
    onStdout: onStdout.event,
    onStderr: onStderr.event,
    onExit: onExit.event,
    start: () => Promise.resolve({ handle }),
    writeStdin: (_h, data) => {
      writes.push(data)
      return Promise.resolve()
    },
    stop: () => Promise.resolve(),
    probe: () => Promise.resolve(true),
  }
  return {
    host,
    handle,
    inject(data: string) {
      onStdout.fire({ handle, data })
    },
    injectStderr(data: string) {
      onStderr.fire({ handle, data })
    },
    written() {
      return writes
    },
    exit(code, signal) {
      onExit.fire({ handle, code, signal })
    },
    exitWithError(error) {
      onExit.fire({ handle, code: null, signal: null, error })
    },
    dispose() {
      onStdout.dispose()
      onStderr.dispose()
      onExit.dispose()
    },
  }
}
