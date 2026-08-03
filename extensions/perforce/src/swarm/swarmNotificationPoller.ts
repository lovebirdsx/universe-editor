/**
 * Drives new-review desktop notifications from the extension host — a Node child
 * process Chromium never background-throttles. The renderer's own poll timer
 * (SwarmReviewNotificationContribution) freezes while the window sits in the
 * background, so notifications never fired overnight; this timer keeps ticking
 * there. Each tick just pokes the renderer via `_workbench.swarmPollTick`; the
 * renderer still owns all the detection / filtering / notification logic (ignore
 * set, author / approvable filters, OS toast + in-app fallback).
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

  constructor(
    private readonly _isConfigured: () => Promise<boolean>,
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
      this._timer = setInterval(() => void this._tick(), this._intervalMs)
      this._logger?.info('status', `poll driver re-armed every ${Math.round(ms / 1000)}s`)
    }
  }

  start(): void {
    if (this._disposed || this._timer) return
    // Immediate first tick — see the header. Worst case the renderer's tick
    // handler isn't mounted yet and this tick no-ops; interval ticks recover.
    void this._tick()
    this._timer = setInterval(() => void this._tick(), this._intervalMs)
    this._logger?.info('status', `poll driver every ${Math.round(this._intervalMs / 1000)}s`)
  }

  /** Mirror of the `perforce.swarm.backgroundPoll.enabled` switch (default off):
   *  starts the driver when turned on, stops it when turned off. Idempotent. */
  setEnabled(enabled: boolean): void {
    if (enabled) {
      this.start()
    } else if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
      this._logger?.info('status', 'poll driver stopped (backgroundPoll disabled)')
    }
  }

  private async _tick(): Promise<void> {
    if (this._disposed) return
    try {
      if (!(await this._isConfigured())) {
        this._logger?.debug('status', 'poll tick skipped: Swarm not configured')
        return
      }
      // Trace-level heartbeat: with `perforce.swarm.trace` on, a missing tick line
      // in the panel answers "is the host driver even alive?" without a debugger.
      this._logger?.debug('status', 'poll tick → renderer')
      await commands.executeCommand(TICK_COMMAND)
    } catch (err) {
      this._logger?.warn('status', `poll tick failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  dispose(): void {
    this._disposed = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }
}
