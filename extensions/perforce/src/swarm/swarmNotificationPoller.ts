/**
 * Drives new-review desktop notifications from the extension host — a Node child
 * process Chromium never background-throttles. The renderer's own poll timer
 * (SwarmReviewNotificationContribution) freezes while the window sits in the
 * background, so notifications never fired overnight; this timer keeps ticking
 * there. Each tick just pokes the renderer via `_workbench.swarmPollTick`; the
 * renderer still owns all the detection / filtering / notification logic (ignore
 * set, author / approvable filters, OS toast + in-app fallback).
 *
 * RED LINE: the tick path must NEVER await a renderer round-trip before firing the
 * poke. A deeply-backgrounded window answers RPCs slowly (or, under OS-level
 * throttling, not for hours) — awaiting the config read once stalled every later
 * tick silently for 2.5 hours (the 2026-08 incident). The configuration is a
 * synchronous CACHE READ instead, fed by the activation fallback and the
 * renderer's `setBackgroundPoll` pushes. The poke itself is fire-and-forget with
 * an ack watchdog: late acks only warn, they never delay the next tick.
 *
 * Only ticks while Swarm is configured (`isConfigured()` truthy), mirroring the
 * SwarmStatusBarController lifecycle. start() ticks IMMEDIATELY rather than a
 * full interval later: the renderer's self-prime usually no-ops on the host
 * activation race (dashboard command not registered yet), so without the
 * immediate tick the baseline only fills on the first interval tick and a new
 * review waits up to TWO intervals to notify.
 */
import { commands } from '@universe-editor/extension-api'
import type { SwarmLogger } from './swarmLog.js'

const POLL_INTERVAL_MS = 60_000

/** The host→renderer command the renderer's notification contribution answers. */
const TICK_COMMAND = '_workbench.swarmPollTick'

/** How long a poke may go unanswered before the tick is reported wedged. Warning
 *  only — the poke is never cancelled and the next tick fires on schedule; a
 *  backgrounded renderer answering late must not slow the driver down. */
const TICK_ACK_TIMEOUT_MS = 30_000

/** Tick interval resolution, mirroring `resolveSwarmRequestTimeoutMs`: the
 *  `UNIVERSE_SWARM_POLL_INTERVAL_MS` env override (e2e — bypasses the 10s floor
 *  so host-tick-driven specs don't wait a full product interval per phase) wins
 *  over the configured seconds (`perforce.swarm.pollInterval`, 10s floor),
 *  which wins over the 60s default. */
export function resolveSwarmPollIntervalMs(configSeconds: number): number {
  const env = Number(process.env['UNIVERSE_SWARM_POLL_INTERVAL_MS'])
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  if (Number.isFinite(configSeconds) && configSeconds > 0) {
    return Math.max(10, configSeconds) * 1000
  }
  return POLL_INTERVAL_MS
}

export class SwarmNotificationPoller {
  private _timer: ReturnType<typeof setInterval> | undefined
  private _disposed = false
  /** Whether the previous tick's poke went unacknowledged past the watchdog. */
  private _ackTimedOut = false

  /**
   * @param _isConfigured SYNCHRONOUS cache read — `true` ticks, `false` skips,
   * `undefined` (cache not populated yet) fails OPEN and ticks anyway: the poke
   * is harmless (the renderer defends itself against an unregistered dashboard
   * command), while a stuck "not configured" verdict is the silent-death class
   * this poller exists to kill.
   */
  constructor(
    private readonly _isConfigured: () => boolean | undefined,
    private readonly _logger?: SwarmLogger,
    private _intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /** Override the tick interval (from `perforce.swarm.pollInterval`). Applies
   *  even after start(): the renderer's setEnabled(true) push can win the race
   *  against the async config read that sets the interval, and locking the
   *  driver into the default 60s would make detection 6x slower than configured. */
  setIntervalMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this._intervalMs) return
    this._intervalMs = ms
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = setInterval(() => this._tick(), this._intervalMs)
      this._lifecycle(`poll driver re-armed every ${Math.round(ms / 1000)}s`)
    }
  }

  start(): void {
    if (this._disposed || this._timer) return
    // Immediate first tick — see the header. Worst case the renderer's tick
    // handler isn't mounted yet and this tick no-ops; interval ticks recover.
    this._tick()
    this._timer = setInterval(() => this._tick(), this._intervalMs)
    this._lifecycle(`poll driver every ${Math.round(this._intervalMs / 1000)}s`)
  }

  /** Mirror of the `perforce.swarm.backgroundPoll.enabled` switch (default off):
   *  starts the driver when turned on, stops it when turned off. Idempotent. */
  setEnabled(enabled: boolean): void {
    if (enabled) {
      this.start()
    } else if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
      this._lifecycle('poll driver stopped (backgroundPoll disabled)')
    }
  }

  /** Lifecycle lines the 2026-08 incident proved must SURVIVE A RESTART: the Swarm
   *  output channel is in-memory, so mirror them to stderr — the main process
   *  forwards host stderr into the session's extensionHost.log. The host's
   *  stdoutProtection routes every console.* call to stderr with a level tag that
   *  main maps back to a log level, so use the SEMANTIC method: plain console
   *  calls can never touch the RPC wire (stdout), but console.error would
   *  misfile these routine lines as errors. */
  private _lifecycle(message: string): void {
    this._logger?.info('status', message)
    console.info(`[swarm poll] ${message}`)
  }

  private _tick(): void {
    if (this._disposed) return
    const configured = this._isConfigured()
    if (configured === false) {
      this._logger?.debug('status', 'poll tick skipped: Swarm not configured')
      return
    }
    if (configured === undefined) {
      // Cache not populated yet (renderer push hasn't landed / activation
      // fallback still in flight) — fail open. The poke is a no-op when the
      // renderer has no dashboard command, so this costs nothing.
      this._logger?.debug('status', 'poll tick: configured cache cold, failing open')
    }
    // Trace-level heartbeat: with `perforce.swarm.trace` on, a missing tick line
    // in the panel answers "is the host driver even alive?" without a debugger.
    this._logger?.debug('status', 'poll tick → renderer')
    this._poke()
  }

  /** Fire the renderer poke WITHOUT blocking the tick lifecycle. A deeply-
   *  backgrounded window answers RPCs slowly (Chromium/OS throttling); awaiting
   *  the ack once froze every later tick for hours (the promise neither settles
   *  nor rejects, so there is nothing to catch). Instead each poke gets an ack
   *  watchdog: late acks warn (per tick, so a wedged renderer leaves exactly one
   *  log line per interval — the missing-log evidence of the 2026-08 incident),
   *  and the first ack after a timeout window logs the recovery. The poke's own
   *  rejection is caught here so it can never escape as an unhandled rejection
   *  in the host process. */
  /** Watchdogs of in-flight pokes (several when the interval < ack timeout, e.g.
   *  e2e's 1s interval). Cleared on ack and on dispose. */
  private readonly _watchdogs = new Set<ReturnType<typeof setTimeout>>()

  private _poke(): void {
    const watchdog = setTimeout(() => {
      this._watchdogs.delete(watchdog)
      this._ackTimedOut = true
      // Mirrored to stderr (→ extensionHost.log): a wedged renderer leaves one
      // of these per interval — the evidence the 2026-08 incident lacked.
      const message = `poll tick not acknowledged by renderer within ${Math.round(TICK_ACK_TIMEOUT_MS / 1000)}s`
      this._logger?.warn('status', message)
      console.warn(`[swarm poll] ${message}`)
    }, TICK_ACK_TIMEOUT_MS)
    this._watchdogs.add(watchdog)
    Promise.resolve(commands.executeCommand(TICK_COMMAND)).then(
      () => {
        clearTimeout(watchdog)
        this._watchdogs.delete(watchdog)
        if (this._ackTimedOut) {
          this._ackTimedOut = false
          this._logger?.info('status', 'poll tick ack restored')
          console.info('[swarm poll] poll tick ack restored')
        }
      },
      (err: unknown) => {
        clearTimeout(watchdog)
        this._watchdogs.delete(watchdog)
        this._ackTimedOut = false
        this._logger?.warn(
          'status',
          `poll tick failed: ${err instanceof Error ? err.message : err}`,
        )
      },
    )
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
    for (const watchdog of this._watchdogs) clearTimeout(watchdog)
    this._watchdogs.clear()
  }
}
