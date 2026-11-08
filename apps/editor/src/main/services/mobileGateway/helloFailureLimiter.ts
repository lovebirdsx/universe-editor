/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sliding-window limiter for failed WebSocket hellos, keyed by remote address.
 *  Successful authentication never records anything. Under Tailscale Serve every
 *  phone arrives from 127.0.0.1, so the threshold is deliberately generous.
 *--------------------------------------------------------------------------------------------*/

export const HELLO_FAILURE_WINDOW_MS = 60_000
// Tailscale Serve proxies every phone from 127.0.0.1, so one window is shared by
// all clients; keep the cap high enough that a legitimate typo cannot lock out
// the PC itself (successful hellos are not counted).
export const MAX_HELLO_FAILURES_PER_ADDRESS = 10

export interface HelloFailureDecision {
  /** True once the address has reached the cap and upgrades must be rejected. */
  readonly blocked: boolean
  /** True when this failure should be written to the audit log. */
  readonly audit: boolean
  /** Failures deliberately skipped since the last written audit entry. */
  readonly suppressed: number
}

interface AddressState {
  times: number[]
  suppressed: number
}

export class HelloFailureLimiter {
  private readonly _states = new Map<string, AddressState>()

  constructor(
    private readonly _now: () => number = Date.now,
    private readonly _windowMs = HELLO_FAILURE_WINDOW_MS,
    private readonly _maxFailures = MAX_HELLO_FAILURES_PER_ADDRESS,
  ) {}

  isBlocked(address: string): boolean {
    const state = this._fresh(address, this._now())
    return state !== undefined && state.times.length >= this._maxFailures
  }

  recordFailure(address: string): HelloFailureDecision {
    const now = this._now()
    const state = this._fresh(address, now) ?? { times: [], suppressed: 0 }
    state.times.push(now)
    this._states.set(address, state)

    if (state.times.length === 1) {
      state.suppressed = 0
      return { blocked: state.times.length >= this._maxFailures, audit: true, suppressed: 0 }
    }
    if (state.times.length === this._maxFailures) {
      const suppressed = state.suppressed
      state.suppressed = 0
      return { blocked: true, audit: true, suppressed }
    }
    if (state.times.length > this._maxFailures) {
      return { blocked: true, audit: false, suppressed: state.suppressed }
    }
    state.suppressed += 1
    return { blocked: false, audit: false, suppressed: state.suppressed }
  }

  /** Drop timestamps that fell out of the window; a fully stale address is forgotten. */
  private _fresh(address: string, now: number): AddressState | undefined {
    const state = this._states.get(address)
    if (state === undefined) return undefined
    const fresh = state.times.filter((time) => now - time < this._windowMs)
    if (fresh.length === 0) {
      this._states.delete(address)
      return undefined
    }
    state.times = fresh
    return state
  }
}
