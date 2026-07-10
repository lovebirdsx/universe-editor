/**
 * Auto-checkout on edit ("autoEdit"). When enabled, the first local edit to a
 * depot-controlled file that isn't already open triggers `p4 edit`, so typing in
 * a synced-read-only file just works — matching the community perforce plugin's
 * `editOnFileModified` behaviour. Off by default (opening files for edit is a
 * server mutation; users opt in).
 *
 * We key off {@link WorkspaceApi.onDidChangeTextDocument} rather than a save
 * event (the host has no save hook), debouncing per-file so a burst of keystrokes
 * spawns at most one `p4 edit`. A short-lived in-flight set prevents re-entry
 * while the edit round-trips.
 */
import {
  workspace,
  type Disposable,
  type UriComponents,
  type WorkspaceConfiguration,
} from '@universe-editor/extension-api'
import type { ClientManager } from './clientManager.js'
import { uriToFsPath } from './pathUtil.js'

export class AutoEditController {
  private _enabled = false
  private readonly _inFlight = new Set<string>()
  private readonly _disposables: Disposable[] = []

  constructor(
    private readonly _mgr: ClientManager,
    private readonly _log?: (msg: string) => void,
  ) {}

  /** Read the config once and, when enabled, subscribe to document changes. */
  async start(cfg: WorkspaceConfiguration): Promise<void> {
    this._enabled = await cfg.get('autoEdit', false)
    if (!this._enabled) return
    this._disposables.push(
      workspace.onDidChangeTextDocument((e) => void this._onChange(e.document.uri)),
    )
    this._log?.('[perforce] autoEdit enabled')
  }

  private async _onChange(uri: UriComponents): Promise<void> {
    if (!this._enabled) return
    const path = uriToFsPath(uri)
    if (!path || this._inFlight.has(path)) return

    const client = this._mgr.resolveClient({ resourceUri: path })
    if (!client) return

    this._inFlight.add(path)
    try {
      // `p4 edit` is a no-op (non-error) if the file is already open, so we don't
      // need to pre-check `opened` — just fire and let the refresh reconcile.
      await client.edit([path])
    } catch (err) {
      this._log?.(`[perforce] autoEdit failed for ${path}: ${String(err)}`)
    } finally {
      this._inFlight.delete(path)
    }
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose()
    this._disposables.length = 0
    this._inFlight.clear()
  }
}
