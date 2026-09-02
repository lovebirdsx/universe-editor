/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mirrors JSON-RPC traffic flowing through `sdkHostStream` into a VSCode-style
 *  Output channel. Each tracer owns its own line buffer + pending-id table so
 *  multiple concurrent ACP connections can safely share a single channel.
 *--------------------------------------------------------------------------------------------*/

import { NullLogger, type ILogger, type IOutputChannel } from '@universe-editor/platform'

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

/**
 * Line reassembly state for one direction. `scan` is where the next `\n` search
 * starts so a partial line (e.g. a multi-MB base64 image replayed on resume,
 * arriving as ~64KB chunks) is scanned once total, not re-scanned from the head
 * on every chunk — the old code was O(m²) in the line length. `dropped` counts
 * bytes elided once a single line exceeds MAX_TRACE_LINE: we stop buffering it,
 * never JSON.parse it, and emit a compact placeholder at end-of-line.
 */
interface LineBuffer {
  buf: string
  scan: number
  dropped: number
}

/** Above this, a single JSON-RPC line is treated as an oversized frame and elided. */
const MAX_TRACE_LINE = 512 * 1024

export class AcpProtocolTracer {
  private readonly _in: LineBuffer = { buf: '', scan: 0, dropped: 0 }
  private readonly _out: LineBuffer = { buf: '', scan: 0, dropped: 0 }
  private readonly _pending = new Map<number | string, PendingRequest>()

  constructor(
    private readonly _channel: IOutputChannel,
    private readonly _logger: ILogger,
    private readonly _source: string,
    private readonly _errorLogger: ILogger = new NullLogger(),
  ) {}

  traceOutboundChunk(text: string): void {
    this._feed(this._out, text, 'send')
  }

  traceInboundChunk(text: string): void {
    this._feed(this._in, text, 'recv')
  }

  dispose(): void {
    this._in.buf = ''
    this._in.scan = 0
    this._in.dropped = 0
    this._out.buf = ''
    this._out.scan = 0
    this._out.dropped = 0
    this._pending.clear()
  }

  private _feed(state: LineBuffer, text: string, dir: Direction): void {
    state.buf += text
    for (;;) {
      const nl = state.buf.indexOf('\n', state.scan)
      if (nl < 0) {
        // No full line yet. If the pending line already blew past the cap, drop
        // it (keep only a byte count) so we never accumulate or parse megabytes.
        if (state.buf.length > MAX_TRACE_LINE) {
          state.dropped += state.buf.length
          state.buf = ''
          state.scan = 0
        } else {
          state.scan = state.buf.length
        }
        return
      }
      const rawLine = state.buf.slice(0, nl)
      state.buf = state.buf.slice(nl + 1)
      state.scan = 0
      if (state.dropped > 0) {
        this._emitOversized(dir, state.dropped + rawLine.length)
        state.dropped = 0
        continue
      }
      if (rawLine.length > MAX_TRACE_LINE) {
        this._emitOversized(dir, rawLine.length)
        continue
      }
      const line = rawLine.trim()
      if (line) this._emit(dir, line)
    }
  }

  private _emitOversized(dir: Direction, bytes: number): void {
    const arrow = dir === 'send' ? '→' : '←'
    const head = `[Trace - ${formatTs(new Date())}] [${this._source}] ${arrow}`
    const msg = `<large frame ${bytes} bytes elided>`
    this._channel.appendLine(`${head} ${msg}`)
    this._channel.appendLine('')
    this._logger.info(`[${this._source}] ${arrow} ${msg}`)
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
      if (isFailedToolCallUpdate(msg)) {
        // Keep a low-volume, high-signal record of tool failures in a separate
        // channel so it survives the rotation of the full protocol trace.
        this._errorLogger.info(
          `${logPrefix} tool_call_update failed${sTag} params=${compactJson(msg.params)}`,
        )
      }
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
      if (isErr) {
        // JSON-RPC error responses are the exact failure signal a diagnosis
        // needs; mirror them to the low-volume error channel so they survive
        // rotation of the full protocol trace.
        this._errorLogger.info(
          `${logPrefix} Response '${m}' (${String(id)}) in ${elapsed} ERROR error=${compactJson(msg.error)}`,
        )
      }
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

/** A `session/update` notification carrying a failed `tool_call_update`. */
function isFailedToolCallUpdate(msg: JsonRpcMessage): boolean {
  if (msg.method !== 'session/update') return false
  const params = msg.params
  if (params === null || typeof params !== 'object') return false
  const update = (params as Record<string, unknown>).update
  if (update === null || typeof update !== 'object') return false
  const u = update as Record<string, unknown>
  return u.sessionUpdate === 'tool_call_update' && u.status === 'failed'
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(redactForTrace(v), null, 2)
  } catch {
    return String(v)
  }
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(redactForTrace(v)) ?? 'undefined'
  } catch {
    return String(v)
  }
}

const MAX_TRACE_STRING = 2048

/**
 * Replaces base64 image/audio payloads and any oversized string with a compact
 * placeholder before serialization. Resuming a session replays every stored
 * image as a full-base64 chunk; serializing those verbatim (pretty + compact)
 * into an unbounded Output channel froze the main thread. Trace-only — the real
 * protocol data is untouched.
 */
export function redactForTrace(v: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_TRACE_STRING ? `<string ${v.length} chars>` : v
  }
  if (v === null || typeof v !== 'object') return v
  if (seen.has(v)) return '<circular>'
  seen.add(v)

  if (Array.isArray(v)) return v.map((item) => redactForTrace(item, seen))

  const src = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const isMedia = src.type === 'image' || src.type === 'audio'
  for (const key of Object.keys(src)) {
    const value = src[key]
    if (isMedia && key === 'data' && typeof value === 'string') {
      out[key] = `<base64 ${value.length} chars>`
    } else {
      out[key] = redactForTrace(value, seen)
    }
  }
  return out
}
