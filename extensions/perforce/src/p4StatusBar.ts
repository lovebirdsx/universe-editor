/**
 * The Perforce status-bar entry: client name + connection state. A single item
 * renders whichever client is active — switching the SCM selection re-points it,
 * mirroring VSCode's single-repo status bar (and git's GitStatusBarController).
 * Clicking opens the Perforce output channel.
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
    this._item.command = 'perforce.showOutput'
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
    const { clientName, connection } = client.status
    const suffix =
      connection === 'offline'
        ? ` (${localize('perforce.status.offline', 'offline')})`
        : connection === 'not-logged-in'
          ? ` (${localize('perforce.status.notLoggedIn', 'not logged in')})`
          : ''
    this._item.text = `$(server) ${clientName}${suffix}`
    this._item.tooltip = `Perforce client: ${clientName}`
    this._item.show()
  }

  dispose(): void {
    this._clientSub?.dispose()
    this._item.dispose()
  }
}
