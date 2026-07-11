/**
 * The Perforce status-bar entry: client name + connection state. A single item
 * renders whichever client is active — switching the SCM selection re-points it,
 * mirroring VSCode's single-repo status bar (and git's GitStatusBarController).
 * Clicking opens the Perforce graph.
 */
import {
  window,
  StatusBarAlignment,
  type Disposable,
  type StatusBarItem,
} from '@universe-editor/extension-api'
import type { ClientManager } from './clientManager.js'
import { localize } from './nls.js'

export class P4StatusBarController {
  private readonly _item: StatusBarItem
  private _clientSub: Disposable | undefined

  constructor(private readonly _mgr: ClientManager) {
    this._item = window.createStatusBarItem(StatusBarAlignment.Left, 100)
    this._item.command = 'perforce-graph.view'
  }

  /** Re-point at the active client and re-render. Call after the active client
   *  changes or a new client is added. */
  refresh(): void {
    const client = this._mgr.active
    this._clientSub?.dispose()
    this._clientSub = client?.onDidChange(() => this._render())
    this._render()
  }

  private _render(): void {
    const client = this._mgr.active
    if (!client) {
      this._item.hide()
      return
    }
    const { clientName, connection, openedCount, reconcileCount } = client.status
    if (connection === 'offline') {
      this._item.text = `$(server) ${clientName} (${localize('perforce.status.offline', 'offline')})`
    } else if (connection === 'not-logged-in') {
      this._item.text = `$(server) ${clientName} (${localize('perforce.status.notLoggedIn', 'not logged in')})`
    } else {
      // Connected: client name + open-file count, and the uncollected count when
      // reconcile discovery has surfaced any (mirrors git's ahead/behind chips).
      const counts =
        reconcileCount > 0 ? ` ${openedCount} $(edit) ${reconcileCount} $(diff)` : ` ${openedCount}`
      this._item.text = `$(server) ${clientName}${counts}`
    }
    this._item.tooltip = 'Open Perforce Graph'
    this._item.show()
  }

  dispose(): void {
    this._clientSub?.dispose()
    this._item.dispose()
  }
}
