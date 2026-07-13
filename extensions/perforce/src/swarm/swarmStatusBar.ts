/**
 * The Swarm status-bar entry: "N reviews need my attention". Polls the action
 * dashboard on an interval (opt-in via `perforce.swarm.pollInterval`) and on
 * demand. Clicking focuses the Swarm Reviews view (a renderer Action2, routed via
 * the command service). Mirrors p4StatusBar's lifecycle.
 */
import {
  window,
  commands,
  StatusBarAlignment,
  type StatusBarItem,
} from '@universe-editor/extension-api'
import type { SwarmClient } from './swarmClient.js'
import type { SwarmLogger } from './swarmLog.js'
import { localize } from '../nls.js'

export class SwarmStatusBarController {
  private readonly _item: StatusBarItem
  private _timer: ReturnType<typeof setInterval> | undefined
  private _disposed = false
  /** Review ids that needed my action on the last poll; drives new-review toasts. */
  private _knownNeedsAction = new Set<string>()
  /** First poll primes the baseline without notifying (avoids a startup burst). */
  private _primed = false

  constructor(
    private readonly _getClient: () => Promise<SwarmClient | undefined>,
    private readonly _logger?: SwarmLogger,
  ) {
    this._item = window.createStatusBarItem(StatusBarAlignment.Left, 99)
    // Focus the Swarm Reviews view (renderer Action2 id).
    this._item.command = 'swarm.openReviews'
    this._item.tooltip = localize('perforce.swarm.status.tooltip', 'Open Swarm Reviews')
  }

  /** Poll every `seconds` (0 / negative disables); floors at 10s. */
  startPolling(seconds: number): void {
    this.stopPolling()
    void this.refresh()
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const ms = Math.max(10, seconds) * 1000
    this._timer = setInterval(() => void this.refresh(), ms)
    this._logger?.info('status', `polling every ${Math.round(ms / 1000)}s`)
  }

  stopPolling(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }

  /** Re-fetch the dashboard count and re-render. Hides the item when Swarm is
   *  unconfigured or the fetch fails (no noise). */
  async refresh(): Promise<void> {
    if (this._disposed) return
    const client = await this._getClient()
    if (!client) {
      this._item.hide()
      return
    }
    try {
      const dash = await client.dashboard()
      if (this._disposed) return
      const count = dash.needsAction.length
      this._logger?.debug(
        'status',
        `dashboard: ${count} need action, ${dash.authored.length} authored, ${dash.participating.length} participating`,
      )
      this._item.text = `$(git-pull-request) ${count}`
      this._item.tooltip =
        count > 0
          ? localize('perforce.swarm.status.count', '{0} reviews need your attention', {
              0: String(count),
            })
          : localize('perforce.swarm.status.none', 'No reviews need your attention')
      this._item.show()
      this._notifyNewReviews(dash.needsAction.map((r) => r.id))
    } catch (err) {
      this._logger?.warn('status', `refresh failed: ${err instanceof Error ? err.message : err}`)
      this._item.hide()
    }
  }

  /** Toast once per newly-appeared needs-action review (throttled: only the ids
   *  not seen on the previous poll). The first poll only primes the baseline. */
  private _notifyNewReviews(ids: string[]): void {
    const current = new Set(ids)
    if (!this._primed) {
      this._knownNeedsAction = current
      this._primed = true
      return
    }
    const fresh = ids.filter((id) => !this._knownNeedsAction.has(id))
    this._knownNeedsAction = current
    if (fresh.length === 0) return
    const message =
      fresh.length === 1
        ? localize('perforce.swarm.notify.one', 'Review #{0} needs your attention.', {
            0: fresh[0] as string,
          })
        : localize('perforce.swarm.notify.many', '{0} new reviews need your attention.', {
            0: String(fresh.length),
          })
    const open = localize('perforce.swarm.notify.open', 'Open')
    void window.showInformationMessage(message, open).then((picked) => {
      if (picked !== open) return
      if (fresh.length === 1) {
        void commands.executeCommand('_workbench.openSwarmReview', fresh[0])
      } else {
        void commands.executeCommand('_workbench.openSwarmReviews')
      }
    })
  }

  dispose(): void {
    this._disposed = true
    this.stopPolling()
    this._item.dispose()
  }
}
