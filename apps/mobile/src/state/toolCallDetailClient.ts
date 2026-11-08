import type {
  CommandFrame,
  CommandResultFrame,
  MobileErrorCode,
  MobileSessionRef,
  MobileToolCallDetail,
} from '@universe-editor/mobile-protocol'

export const TOOL_CALL_DETAIL_TIMEOUT_MS = 10_000

export type ToolCallDetailErrorCode = MobileErrorCode | 'timeout' | 'invalid_response' | 'cancelled'

export class ToolCallDetailError extends Error {
  readonly code: ToolCallDetailErrorCode

  constructor(code: ToolCallDetailErrorCode, message: string) {
    super(message)
    this.name = 'ToolCallDetailError'
    this.code = code
  }
}

export interface ToolCallDetailTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ToolCallDetailClientOptions {
  readonly send: (frame: CommandFrame) => void
  readonly timers?: ToolCallDetailTimers | undefined
  readonly timeoutMs?: number | undefined
  readonly createRequestId?: (() => string) | undefined
}

interface PendingRequest {
  readonly toolCallId: string
  readonly resolve: (detail: MobileToolCallDetail) => void
  readonly reject: (error: ToolCallDetailError) => void
  readonly timer: unknown
}

const defaultTimers: ToolCallDetailTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Request/response correlation for `getToolCallDetail`: one pending map keyed by
 * request id, a 10s deadline, and a cache keyed by tool-call id. The client
 * invalidates a cached card whenever its tool-call state changes.
 */
export class ToolCallDetailClient {
  private readonly _send: (frame: CommandFrame) => void
  private readonly _timers: ToolCallDetailTimers
  private readonly _timeoutMs: number
  private readonly _createRequestId: () => string
  private readonly _pending = new Map<string, PendingRequest>()
  private readonly _cache = new Map<string, MobileToolCallDetail>()
  private _counter = 0

  constructor(options: ToolCallDetailClientOptions) {
    this._send = options.send
    this._timers = options.timers ?? defaultTimers
    this._timeoutMs = options.timeoutMs ?? TOOL_CALL_DETAIL_TIMEOUT_MS
    this._createRequestId = options.createRequestId ?? (() => `detail-${++this._counter}`)
  }

  request(ref: MobileSessionRef, toolCallId: string): Promise<MobileToolCallDetail> {
    const cached = this._cache.get(toolCallId)
    if (cached !== undefined) return Promise.resolve(cached)

    const requestId = this._createRequestId()
    return new Promise<MobileToolCallDetail>((resolve, reject) => {
      const timer = this._timers.setTimeout(() => {
        this._pending.delete(requestId)
        reject(new ToolCallDetailError('timeout', 'tool call detail request timed out'))
      }, this._timeoutMs)
      this._pending.set(requestId, { toolCallId, resolve, reject, timer })
      try {
        this._send({
          type: 'command',
          requestId,
          kind: 'getToolCallDetail',
          payload: { ref, toolCallId },
        })
      } catch (error) {
        this._timers.clearTimeout(timer)
        this._pending.delete(requestId)
        reject(
          new ToolCallDetailError(
            'invalid_response',
            error instanceof Error ? error.message : 'failed to send command',
          ),
        )
      }
    })
  }

  /** True when the frame belonged to a pending detail request. */
  handleResult(frame: CommandResultFrame): boolean {
    const pending = this._pending.get(frame.requestId)
    if (pending === undefined) return false
    this._pending.delete(frame.requestId)
    this._timers.clearTimeout(pending.timer)

    if (!frame.ok) {
      pending.reject(
        new ToolCallDetailError(frame.error ?? 'internal', 'tool call detail request failed'),
      )
      return true
    }
    if (!isToolCallDetail(frame.result)) {
      pending.reject(
        new ToolCallDetailError('invalid_response', 'tool call detail response is malformed'),
      )
      return true
    }
    this._cache.set(pending.toolCallId, frame.result)
    pending.resolve(frame.result)
    return true
  }

  invalidate(toolCallId: string): void {
    this._cache.delete(toolCallId)
  }

  clear(): void {
    this._cache.clear()
    for (const [requestId, pending] of this._pending) {
      this._timers.clearTimeout(pending.timer)
      pending.reject(new ToolCallDetailError('cancelled', 'tool call detail request cancelled'))
      this._pending.delete(requestId)
    }
  }
}

function isToolCallDetail(value: unknown): value is MobileToolCallDetail {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['title'] === 'string' &&
    typeof record['kind'] === 'string' &&
    typeof record['status'] === 'string' &&
    typeof record['text'] === 'string' &&
    Array.isArray(record['diffs'])
  )
}
