/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auto-recovery shared primitives: the observable state the UI renders
 *  (retry / reconnect progress, countdown, exhausted), the backoff schedule,
 *  and a small tracker that owns the pending-attempt timer so both recovery
 *  tiers (in-place prompt retry on the session, service-driven reconnect)
 *  share one cancellation + countdown implementation.
 *
 *  Two tiers produce these states:
 *    - `retrying`    — the connection is alive but the turn failed transiently
 *                      (429 / overloaded / 5xx); the session re-dispatches the
 *                      prompt after a backoff.
 *    - `reconnecting`— the agent process died (or stalled); the service is
 *                      re-handshaking (spawn + session/resume) in place.
 *    - `exhausted`   — automatic attempts ran out; the timeline shows the
 *                      error and the UI offers a manual retry.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type ISettableObservable } from '@universe-editor/platform'

export type AcpRecoveryPhase = 'retrying' | 'reconnecting' | 'exhausted'

export interface AcpRecoveryState {
  readonly phase: AcpRecoveryPhase
  /** 1-based attempt currently in flight (or scheduled). */
  readonly attempt: number
  readonly maxAttempts: number
  /** Short machine-ish reason for display/telemetry (e.g. `http_429`, `crash`). */
  readonly reason: string
  /** Epoch ms when the next attempt fires; drives the UI countdown. */
  readonly nextAttemptAt?: number
}

/** Max automatic attempts per recovery episode (retry tier and reconnect tier alike). */
export const MAX_RECOVERY_ATTEMPTS = 3

/** Backoff per attempt (index 0 = wait before attempt 2). */
const BACKOFF_MS: readonly number[] = [2_000, 8_000, 20_000]

/**
 * Test-only override for the backoff schedule so recovery tests don't wait
 * real seconds. Production never sets this. Returns a disposer that restores
 * the default schedule.
 */
let backoffOverride: ((nextAttempt: number) => number) | undefined
export function __setRecoveryBackoffForTests(fn: ((n: number) => number) | undefined): void {
  backoffOverride = fn
}

/** Delay before attempt `nextAttempt` (1-based: pass the attempt about to run). */
export function recoveryBackoffMs(nextAttempt: number): number {
  if (backoffOverride) return backoffOverride(nextAttempt)
  const base = BACKOFF_MS[Math.min(Math.max(nextAttempt - 2, 0), BACKOFF_MS.length - 1)]!
  // ±25% jitter so several sessions limited at the same instant don't retry in lockstep.
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/**
 * Owns the recovery observable + the single pending-attempt timer for one
 * session. The session and the service both drive it; cancellation (user
 * pressed Stop/取消, or the session closed) rejects the pending sleep so the
 * in-progress recovery loop unwinds immediately instead of firing late.
 */
export class SessionRecovery {
  readonly state: ISettableObservable<AcpRecoveryState | undefined> = observableValue<
    AcpRecoveryState | undefined
  >('acp.session.recovery', undefined)

  private _timer: ReturnType<typeof setTimeout> | undefined
  private _rejectSleep: ((err: Error) => void) | undefined

  /** Publish (or patch) the current recovery state. */
  set(state: AcpRecoveryState): void {
    this.state.set(state, undefined)
  }

  /** Recovery succeeded (or a fresh user action superseded it) — clear state. */
  clear(): void {
    this._cancelTimer()
    if (this.state.get() !== undefined) this.state.set(undefined, undefined)
  }

  /** Cancel the pending sleep, if any. Does NOT clear the visible state. */
  cancelPending(): void {
    this._cancelTimer()
  }

  get hasPending(): boolean {
    return this._timer !== undefined
  }

  /**
   * Cancellable sleep used between attempts. Rejects with {@link err} (or an
   * Error) when {@link cancelPending}/{@link clear} runs, letting the awaiting
   * recovery loop bail out without racing a late timer fire.
   */
  sleep(ms: number): Promise<void> {
    this._cancelTimer()
    return new Promise<void>((resolve, reject) => {
      this._rejectSleep = reject
      this._timer = setTimeout(() => {
        this._timer = undefined
        this._rejectSleep = undefined
        resolve()
      }, ms)
    })
  }

  dispose(): void {
    this._cancelTimer()
  }

  private _cancelTimer(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }
    const reject = this._rejectSleep
    this._rejectSleep = undefined
    reject?.(new Error('recovery cancelled'))
  }
}
