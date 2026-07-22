/**
 * The Swarm status-bar entry: "N reviews need my attention". Clicking focuses
 * the Swarm Reviews view (a renderer Action2, routed via the command service).
 * Mirrors p4StatusBar's lifecycle.
 *
 * The displayed count is PUSHED by the renderer (`perforce.swarm.setStatusCount`)
 * and matches the sidebar's "Needs My Action" group scope — author / approvable
 * filters and the client-side ignore set applied. The host must NOT re-derive it
 * from the raw dashboard `needsAction` length: those filters live renderer-side,
 * so any host-side derivation diverges (the status bar once showed 30 while the
 * sidebar showed 0). This controller only owns show/hide (Swarm availability)
 * and rendering the last pushed count.
 */
import { window, StatusBarAlignment, type StatusBarItem } from '@universe-editor/extension-api'
import type { SwarmClient } from './swarmClient.js'
import type { SwarmLogger } from './swarmLog.js'
import { localize } from '../nls.js'

export class SwarmStatusBarController {
  private readonly _item: StatusBarItem
  private _disposed = false
  private _count = 0
  /** Last known Swarm availability; gates show/hide. False until the first
   *  refresh() resolves, so a pushed count can't surface the item prematurely. */
  private _available = false

  constructor(
    private readonly _getClient: () => Promise<SwarmClient | undefined>,
    private readonly _logger?: SwarmLogger,
  ) {
    this._item = window.createStatusBarItem(StatusBarAlignment.Left, 99)
    // Focus the Swarm Reviews view (renderer Action2 id).
    this._item.command = 'swarm.openReviews'
    this._item.tooltip = localize('perforce.swarm.status.tooltip', 'Open Swarm Reviews')
  }

  /** Re-check Swarm availability (config + connection) and show/hide the item.
   *  Deliberately does NOT touch the count — that is renderer-owned (see header). */
  async refresh(): Promise<void> {
    if (this._disposed) return
    try {
      this._available = (await this._getClient()) !== undefined
    } catch (err) {
      this._logger?.warn(
        'status',
        `availability check failed: ${err instanceof Error ? err.message : err}`,
      )
      this._available = false
    }
    this._render()
  }

  /** Renderer-pushed "Needs My Action" count (sidebar group scope). */
  setCount(count: number): void {
    if (this._disposed) return
    this._count = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    this._render()
  }

  private _render(): void {
    if (this._disposed) return
    if (!this._available) {
      this._item.hide()
      return
    }
    const count = this._count
    this._item.text = `$(git-pull-request) ${count}`
    this._item.tooltip =
      count > 0
        ? localize('perforce.swarm.status.count', '{0} reviews need your attention', {
            0: String(count),
          })
        : localize('perforce.swarm.status.none', 'No reviews need your attention')
    this._item.show()
  }

  dispose(): void {
    this._disposed = true
    this._item.dispose()
  }
}
