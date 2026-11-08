import type { PairRequest } from '@universe-editor/mobile-protocol'
import { vi } from 'vitest'
import type { CredentialStore, StoredCredentials } from '../credentials.js'
import type { PairRequestResult } from '../pairing.js'
import type { TimerApi, TimerHandle, WebSocketLike } from '../socket/mobileSocket.js'

interface TimeoutEntry {
  readonly at: number
  readonly callback: () => void
}

interface IntervalEntry {
  readonly interval: number
  next: number
  readonly callback: () => void
}

/** Deterministic clock driven by `advance()`; interval cadence is preserved. */
export class FakeTimers implements TimerApi {
  private _now = 0
  private _nextHandle = 1
  private readonly _timeouts = new Map<number, TimeoutEntry>()
  private readonly _intervals = new Map<number, IntervalEntry>()

  now(): number {
    return this._now
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = this._nextHandle++
    this._timeouts.set(handle, { at: this._now + delayMs, callback })
    return handle
  }

  clearTimeout(handle: TimerHandle): void {
    this._timeouts.delete(handle as number)
  }

  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const handle = this._nextHandle++
    this._intervals.set(handle, {
      interval: intervalMs,
      next: this._now + intervalMs,
      callback,
    })
    return handle
  }

  clearInterval(handle: TimerHandle): void {
    this._intervals.delete(handle as number)
  }

  advance(delayMs: number): void {
    const target = this._now + delayMs
    for (;;) {
      let bestTime = Number.POSITIVE_INFINITY
      let bestTimeout: number | undefined
      let bestInterval: number | undefined
      for (const [handle, entry] of this._timeouts) {
        if (entry.at <= target && entry.at < bestTime) {
          bestTime = entry.at
          bestTimeout = handle
          bestInterval = undefined
        }
      }
      for (const [handle, entry] of this._intervals) {
        if (entry.next <= target && entry.next < bestTime) {
          bestTime = entry.next
          bestTimeout = undefined
          bestInterval = handle
        }
      }
      if (bestTimeout === undefined && bestInterval === undefined) break

      this._now = bestTime
      if (bestTimeout !== undefined) {
        const entry = this._timeouts.get(bestTimeout)
        this._timeouts.delete(bestTimeout)
        entry?.callback()
      } else if (bestInterval !== undefined) {
        const entry = this._intervals.get(bestInterval)
        if (entry !== undefined) {
          entry.next += entry.interval
          entry.callback()
        }
      }
    }
    this._now = target
  }

  /** Delays (relative to now) of all pending one-shot timers, ascending. */
  pendingTimeoutDelays(): number[] {
    return [...this._timeouts.values()].map((entry) => entry.at - this._now).sort((a, b) => a - b)
  }
}

/** Minimal WebSocket double exposing server-side hooks. */
export class FakeWebSocket implements WebSocketLike {
  readonly url: string
  readyState = 0
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  serverSendRaw(data: unknown): void {
    this.onmessage?.({ data })
  }

  serverClose(code = 1000, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

export function sentFrames(socket: FakeWebSocket): unknown[] {
  return socket.sent.map((text) => JSON.parse(text) as unknown)
}

export interface PairingStoreHarness {
  readonly store: CredentialStore
  readonly saved: () => StoredCredentials | undefined
  readonly saveCalls: () => number
}

export function createPairingStoreHarness(
  options: { readonly persisted?: boolean } = {},
): PairingStoreHarness {
  let stored: StoredCredentials | undefined
  let saves = 0
  const persisted = options.persisted ?? true
  return {
    store: {
      async load() {
        return stored
      },
      async save(credentials) {
        stored = credentials
        saves += 1
        return { persisted }
      },
      async clear() {
        stored = undefined
      },
    },
    saved: () => stored,
    saveCalls: () => saves,
  }
}

export function successfulPairRequester() {
  return vi.fn(
    async (_input: PairRequest): Promise<PairRequestResult> => ({
      ok: true,
      response: {
        deviceId: 'device-12345678',
        token: 'token-value',
        pcName: 'PC-A',
        protocolVersion: 1,
      },
    }),
  )
}

export function failingPairRequester(code: string, network = false) {
  return vi.fn(
    async (_input: PairRequest): Promise<PairRequestResult> => ({ ok: false, code, network }),
  )
}
