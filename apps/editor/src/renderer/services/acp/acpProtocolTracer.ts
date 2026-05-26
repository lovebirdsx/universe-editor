/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mirrors JSON-RPC traffic flowing through `sdkHostStream` into a VSCode-style
 *  Output channel. Each tracer owns its own line buffer + pending-id table so
 *  multiple concurrent ACP connections can safely share a single channel.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger, IOutputChannel } from '@universe-editor/platform'

type Direction = 'send' | 'recv'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface PendingRequest {
  readonly method: string
  readonly startMs: number
}

export class AcpProtocolTracer {
  private _inBuf = ''
  private _outBuf = ''
  private readonly _pending = new Map<number | string, PendingRequest>()

  constructor(
    private readonly _channel: IOutputChannel,
    private readonly _logger: ILogger,
    private readonly _source: string,
  ) {}

  traceOutboundChunk(text: string): void {
    this._outBuf = this._consume(this._outBuf + text, 'send')
  }

  traceInboundChunk(text: string): void {
    this._inBuf = this._consume(this._inBuf + text, 'recv')
  }

  dispose(): void {
    this._inBuf = ''
    this._outBuf = ''
    this._pending.clear()
  }

  private _consume(buf: string, dir: Direction): string {
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) this._emit(dir, line)
      idx = buf.indexOf('\n')
    }
    return buf
  }

  private _emit(dir: Direction, line: string): void {
    const arrow = dir === 'send' ? '→' : '←'
    const ts = formatTs(new Date())
    const head = `[Trace - ${ts}] [${this._source}] ${arrow}`
    const logPrefix = `[${this._source}] ${arrow}`

    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      this._channel.appendLine(`${head} <unparseable> ${line.slice(0, 200)}`)
      this._channel.appendLine('')
      this._logger.info(`${logPrefix} <unparseable> ${line.slice(0, 200)}`)
      return
    }

    const method = typeof msg.method === 'string' ? msg.method : undefined
    const id = msg.id
    const hasId = id !== undefined && id !== null
    const sTag = sessionTag(msg.params)

    if (method !== undefined && hasId) {
      this._channel.appendLine(`${head} Request '${method}' (${String(id)})${sTag}`)
      this._channel.appendLine(`Params: ${prettyJson(msg.params)}`)
      this._logger.info(
        `${logPrefix} Request '${method}' (${String(id)})${sTag} params=${compactJson(msg.params)}`,
      )
      if (dir === 'send') this._pending.set(id, { method, startMs: Date.now() })
    } else if (method !== undefined) {
      this._channel.appendLine(`${head} Notification '${method}'${sTag}`)
      this._channel.appendLine(`Params: ${prettyJson(msg.params)}`)
      this._logger.info(
        `${logPrefix} Notification '${method}'${sTag} params=${compactJson(msg.params)}`,
      )
    } else if (hasId) {
      const pending = this._pending.get(id)
      this._pending.delete(id)
      const elapsed = pending ? `${Date.now() - pending.startMs}ms` : '?ms'
      const m = pending?.method ?? '?'
      const isErr = msg.error !== undefined
      this._channel.appendLine(
        `${head} Response '${m}' (${String(id)}) in ${elapsed}${isErr ? ' ERROR' : ''}`,
      )
      this._channel.appendLine(
        `${isErr ? 'Error' : 'Result'}: ${prettyJson(isErr ? msg.error : msg.result)}`,
      )
      this._logger.info(
        `${logPrefix} Response '${m}' (${String(id)}) in ${elapsed}${isErr ? ' ERROR' : ''} ${
          isErr ? 'error' : 'result'
        }=${compactJson(isErr ? msg.error : msg.result)}`,
      )
    } else {
      this._channel.appendLine(`${head} <malformed> ${line.slice(0, 200)}`)
      this._logger.info(`${logPrefix} <malformed> ${line.slice(0, 200)}`)
    }
    this._channel.appendLine('')
  }
}

function formatTs(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function sessionTag(params: unknown): string {
  if (params === null || typeof params !== 'object') return ''
  const p = params as Record<string, unknown>
  const sid =
    typeof p.sessionId === 'string'
      ? p.sessionId
      : typeof p.session_id === 'string'
        ? p.session_id
        : undefined
  if (!sid) return ''
  return ` [session=${sid.slice(0, 13)}]`
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(v)
  }
}
