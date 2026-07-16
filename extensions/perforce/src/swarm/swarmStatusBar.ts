/**
 * The Swarm status-bar entry: "N reviews need my attention". Polls the action
 * dashboard on an interval (opt-in via `perforce.swarm.pollInterval`) and on
 * demand. Clicking focuses the Swarm Reviews view (a renderer Action2, routed via
 * the command service). Mirrors p4StatusBar's lifecycle.
 *
 * Surfacing *new* actionable reviews (desktop notifications) is the renderer's job
 * — SwarmReviewNotificationContribution polls the same dashboard and notifies based
 * on the list as finally displayed (author / approvable / ignore filters applied).
 * This controller only owns the badge count.
 */
import { window, StatusBarAlignment, type StatusBarItem } from '@universe-editor/extension-api'
import type { SwarmClient } from './swarmClient.js'
import type { SwarmLogger } from './swarmLog.js'
import { localize } from '../nls.js'

export class SwarmStatusBarController {
  private readonly _item: StatusBarItem
  private _timer: ReturnType<typeof setInterval> | undefined
  private _disposed = false
  private _refreshing: Promise<void> | undefined
  private _refreshQueued = false

  constructor(
    private readonly _getClient: () => Promise<SwarmClient | undefined>,
    private readonly _logger?: SwarmLogger,
    private readonly _getNeedsActionAuthors?: () => Promise<readonly string[]>,
    private readonly _getReviewWindowDays?: () => Promise<number>,
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
    if (this._refreshing) {
      this._refreshQueued = true
      return this._refreshing
    }
    const refresh = (async () => {
      do {
        this._refreshQueued = false
        await this._refreshOnce()
      } while (this._refreshQueued && !this._disposed)
    })().finally(() => {
      if (this._refreshing === refresh) this._refreshing = undefined
    })
    this._refreshing = refresh
    return refresh
  }

  private async _refreshOnce(): Promise<void> {
    if (this._disposed) return
    const client = await this._getClient()
    if (!client) {
      this._item.hide()
      return
    }
    try {
      const needsActionAuthors = (await this._getNeedsActionAuthors?.()) ?? []
      const windowDays = (await this._getReviewWindowDays?.()) ?? 0
      const dash = await client.dashboard({
        force: true,
        ...(needsActionAuthors.length ? { needsActionAuthors: [...needsActionAuthors] } : {}),
        ...(windowDays > 0 ? { windowDays } : {}),
      })
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
    } catch (err) {
      this._logger?.warn('status', `refresh failed: ${err instanceof Error ? err.message : err}`)
      this._item.hide()
    }
  }

  dispose(): void {
    this._disposed = true
    this.stopPolling()
    this._item.dispose()
  }
}
