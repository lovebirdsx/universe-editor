/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  A hand-rolled MCP stdio transport: newline-delimited JSON-RPC over a spawned
 *  child process, driving the Electron-free `AcpHostService` core.
 *
 *  Why not the SDK's `StdioClientTransport`: it inherits env through its own
 *  allowlist (bypassing the repo's `buildChildEnv` denylist), registers nothing
 *  with the process-role registry, can only SIGTERM (no tree-kill for the
 *  `npx`-style shim case) and drags `cross-spawn` into the bundle.
 *
 *  The transport also keeps a masked tail of the child's stderr — when an MCP
 *  server dies mid-handshake, that tail is the only thing that says why.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, type Event } from '@universe-editor/platform'
import type {
  AcpExitEvent,
  AcpLaunchSpec,
  AcpStartResult,
  AcpStdioChunk,
} from '@universe-editor/platform'
import type { McpJsonRpcMessage, McpTransport } from './mcpSdk.js'
import { DiagnosticTail } from './mcpTargetSafety.js'

/** How many masked stderr lines a dead server gets to explain itself with. */
export const MCP_STDERR_TAIL_LINES = 20

/**
 * Longest unterminated stdout run kept. MCP stdio is newline-delimited JSON-RPC, so
 * anything past this is either a broken server or a hostile one; either way the
 * connection is not usable and the buffer must not grow without bound.
 */
export const MCP_MAX_BUFFER_CHARS = 8 * 1024 * 1024

/**
 * The slice of `IAcpHostService` this transport drives — narrowed so a test can
 * hand over a fake with three methods and three emitters.
 */
export interface McpStdioHost {
  start(spec: AcpLaunchSpec): Promise<AcpStartResult>
  writeStdin(handle: string, data: string): Promise<void>
  stop(handle: string): Promise<void>
  readonly onStdout: Event<AcpStdioChunk>
  readonly onStderr: Event<AcpStdioChunk>
  readonly onExit: Event<AcpExitEvent>
}

/** Why the child is gone; `spawn-failed` covers ENOENT / EACCES before any I/O. */
export interface McpStdioExit {
  readonly kind: 'spawn-failed' | 'exited'
  readonly code: number | null
  readonly signal: string | null
  readonly detail?: string
}

export class McpStdioTransport implements McpTransport {
  // Property (not accessor) declarations matching the SDK's `Transport` shape; the
  // protocol installs them right after construction, before `start()`. `NonNullable`
  // because the indexed access would otherwise re-add `| undefined`, which
  // `exactOptionalPropertyTypes` refuses to satisfy an optional interface member with.
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: NonNullable<McpTransport['onmessage']>

  private readonly _subs = new DisposableStore()
  private readonly _stderr = new DiagnosticTail(MCP_STDERR_TAIL_LINES)
  private _buffer = ''
  private _handle: string | undefined
  private _closing = false
  private _closed = false
  private _exit: McpStdioExit | undefined
  private _protocolError: string | undefined

  constructor(
    private readonly _host: McpStdioHost,
    private readonly _spec: AcpLaunchSpec,
  ) {}

  async start(): Promise<void> {
    const result = await this._host.start(this._spec)
    if (this._closing || this._closed) {
      await this._host.stop(result.handle).catch(() => undefined)
      return
    }
    this._handle = result.handle
    const owned = (handle: string): boolean => handle === result.handle
    this._subs.add(
      this._host.onStdout((chunk) => {
        if (owned(chunk.handle)) this._ingest(chunk.data)
      }),
    )
    this._subs.add(
      this._host.onStderr((chunk) => {
        if (owned(chunk.handle)) this._stderr.push(chunk.data)
      }),
    )
    this._subs.add(
      this._host.onExit((exit) => {
        if (owned(exit.handle)) this._handleExit(exit)
      }),
    )
  }

  async send(message: McpJsonRpcMessage): Promise<void> {
    const handle = this._handle
    if (handle === undefined) {
      throw new Error('McpStdioTransport: transport is not started')
    }
    await this._host.writeStdin(handle, `${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    if (this._closed || this._closing) return
    this._closing = true
    try {
      const handle = this._handle
      if (handle !== undefined) await this._host.stop(handle)
    } finally {
      this._finish()
    }
  }

  /** Masked stderr tail, for the connection-closed event's `detail`. */
  get stderrTail(): string {
    return this._stderr.toString()
  }

  /** Set once the child is gone; `undefined` while it is still running. */
  get exit(): McpStdioExit | undefined {
    return this._exit
  }

  /**
   * Set when the child wrote something that is not MCP. The connection is closed at
   * the same moment: a dropped line may have been the response a caller is waiting
   * for, and there is no way to resynchronise the stream.
   */
  get protocolError(): string | undefined {
    return this._protocolError
  }

  private _handleExit(exit: AcpExitEvent): void {
    this._exit =
      exit.error !== undefined
        ? { kind: 'spawn-failed', code: null, signal: null, detail: exit.error }
        : {
            kind: 'exited',
            code: exit.code,
            signal: exit.signal,
            ...(this._stderr.size > 0 ? { detail: this.stderrTail } : {}),
          }
    // The SDK is mid-`initialize` when a server dies at startup; `onerror` is its
    // out-of-band channel for exactly that, and `onclose` settles the pending request.
    this.onerror?.(new Error(`MCP server exited (${exit.error ?? `code ${exit.code}`})`))
    this._finish()
  }

  private _finish(): void {
    if (this._closed) return
    this._closed = true
    this._subs.dispose()
    this.onclose?.()
  }

  /**
   * Split the byte stream on newlines. A single chunk may hold several messages
   * and a single message may span chunks, so the tail of the buffer is kept.
   */
  private _ingest(chunk: string): void {
    this._buffer += chunk
    for (;;) {
      const index = this._buffer.indexOf('\n')
      if (index === -1) {
        if (this._buffer.length > MCP_MAX_BUFFER_CHARS) {
          this._failProtocol(
            `MCP server wrote ${this._buffer.length} characters without a newline (limit ${MCP_MAX_BUFFER_CHARS})`,
          )
        }
        return
      }
      const line = this._buffer.slice(0, index).replace(/\r$/, '')
      this._buffer = this._buffer.slice(index + 1)
      this._dispatch(line)
      if (this._closed || this._closing) return
    }
  }

  private _dispatch(line: string): void {
    const text = line.trim()
    if (text.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this._failProtocol(`MCP server wrote a non-JSON line: ${text.slice(0, 200)}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || !('jsonrpc' in parsed)) {
      this._failProtocol(`MCP server wrote a non-JSON-RPC message: ${text.slice(0, 200)}`)
      return
    }
    this.onmessage?.(parsed as McpJsonRpcMessage)
  }

  /**
   * The child is not speaking MCP. Report it (the SDK forwards `onerror`), then close:
   * `onclose` is what settles the requests still in flight, so without the close a
   * dropped response would surface as a bare timeout minutes later.
   */
  private _failProtocol(message: string): void {
    if (this._closed || this._closing) return
    this._protocolError ??= message
    this.onerror?.(new Error(message))
    void this.close()
  }
}
