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
 *                      prompt after a backoff — seconds for a blip, minutes for
 *                      a rate limit (see {@link retryBudgetFor}).
 *    - `reconnecting`— the agent process died (or stalled); the service is
 *                      re-handshaking (spawn + session/resume) in place.
 *    - `exhausted`   — automatic attempts ran out; the timeline shows the
 *                      error and the UI offers a manual retry.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type ISettableObservable } from '@universe-editor/platform'
import type { AcpErrorClass } from './acpErrorClassify.js'

export type AcpRecoveryPhase = 'retrying' | 'reconnecting' | 'exhausted'

export interface AcpRecoveryState {
  readonly phase: AcpRecoveryPhase
  /** 1-based attempt currently in flight (or scheduled). */
  readonly attempt: number
  readonly maxAttempts: number
  /**
   * Short machine-ish reason for display/telemetry. A stable token where the UI
   * branches on it (`rate_limited`, `restart`, `wake`, `crash`), otherwise the
   * classifier's kind (e.g. `http_503`).
   */
  readonly reason: string
  /** Epoch ms when the next attempt fires; drives the UI countdown. */
  readonly nextAttemptAt?: number
}

/**
 * Max automatic attempts for an in-place retry on the `transient` schedule, and
 * for one reconnect episode (the service drives that tier). Both want the same
 * few-second patience — do not raise this to lengthen the rate-limit budget,
 * which has its own ({@link RATE_LIMIT_MAX_ATTEMPTS}).
 */
export const MAX_RECOVERY_ATTEMPTS = 3

/** In-place retry budget: which backoff schedule, and how many attempts it allows. */
export type AcpRetryProfile = 'transient' | 'rate_limit'

export interface AcpRetryBudget {
  readonly profile: AcpRetryProfile
  readonly maxAttempts: number
}

/**
 * Budget for an error class that may be retried in place; `undefined` = do not
 * retry. A throttle needs a different order of magnitude than a blip: codex's
 * own retry loop exhausts itself within seconds, so if the editor gives up after
 * ten seconds too, a 429 ends a session that a wait would have saved.
 */
export function retryBudgetFor(cls: AcpErrorClass): AcpRetryBudget | undefined {
  if (cls === 'rate_limited') {
    return { profile: 'rate_limit', maxAttempts: RATE_LIMIT_MAX_ATTEMPTS }
  }
  if (cls === 'transient') return { profile: 'transient', maxAttempts: MAX_RECOVERY_ATTEMPTS }
  return undefined
}

/** Attempts allowed for one rate-limit episode (7 waits, 8 turns on the wire). */
export const RATE_LIMIT_MAX_ATTEMPTS = 8

/** Backoff per attempt (index 0 = wait before attempt 2); the last entry clamps. */
const BACKOFF_MS: Record<AcpRetryProfile, readonly number[]> = {
  transient: [2_000, 8_000, 20_000],
  // Cumulative wait 5+15+30+60×4 = 290s ≈ 5min. The single hop is capped at 60s:
  // a minute-long countdown still reads as "waiting" rather than as a hang, and
  // since a throttle window clears on the provider's schedule, more attempts
  // beat a longer gap.
  rate_limit: [5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000],
}

/**
 * Test-only override for the backoff schedule so recovery tests don't wait real
 * seconds. Receives the same `(nextAttempt, profile)` the real schedule does, so
 * a test can also assert which schedule the caller asked for. Production never
 * sets this; pass `undefined` to restore the real schedule.
 */
let backoffOverride: ((nextAttempt: number, profile: AcpRetryProfile) => number) | undefined
export function __setRecoveryBackoffForTests(
  fn: ((nextAttempt: number, profile: AcpRetryProfile) => number) | undefined,
): void {
  backoffOverride = fn
}

/** Delay before attempt `nextAttempt` (1-based: pass the attempt about to run). */
export function recoveryBackoffMs(
  nextAttempt: number,
  profile: AcpRetryProfile = 'transient',
): number {
  if (backoffOverride) return backoffOverride(nextAttempt, profile)
  const table = BACKOFF_MS[profile]
  const base = table[Math.min(Math.max(nextAttempt - 2, 0), table.length - 1)]!
  // ±25% jitter so several sessions limited at the same instant don't retry in
  // lockstep. Clamped to `base`: the table value is a ceiling the UI promises
  // ("at most a minute"), so jitter only pulls a hop earlier, never pushes it
  // past the cap the countdown text relies on.
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), base)
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
