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
 * SwarmStatusBarController lifecycle. The renderer primes its own baseline on
 * construction, so the first tick need not be immediate.
 */
import { commands } from '@universe-editor/extension-api'
import type { SwarmLogger } from './swarmLog.js'

const POLL_INTERVAL_MS = 60_000

/** The host→renderer command the renderer's notification contribution answers. */
const TICK_COMMAND = '_workbench.swarmPollTick'

export class SwarmNotificationPoller {
  private _timer: ReturnType<typeof setInterval> | undefined
  private _disposed = false

  constructor(
    private readonly _isConfigured: () => Promise<boolean>,
    private readonly _logger?: SwarmLogger,
    private readonly _intervalMs: number = POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this._disposed || this._timer) return
    this._timer = setInterval(() => void this._tick(), this._intervalMs)
    this._logger?.info('status', `poll driver every ${Math.round(this._intervalMs / 1000)}s`)
  }

  private async _tick(): Promise<void> {
    if (this._disposed) return
    try {
      if (!(await this._isConfigured())) return
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
