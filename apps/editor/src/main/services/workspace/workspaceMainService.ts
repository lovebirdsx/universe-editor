/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window workspace state manager. Holds this window's current folder,
 *  coordinates the WORKSPACE storage scope swap, and exposes wire methods to
 *  the renderer through ProxyChannel. The recent list is shared across windows
 *  and lives in RecentWorkspacesMainService — this service delegates to it and
 *  relays its change event.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'node:path'
import {
  Emitter,
  type Event,
  type IDisposable,
  type ILogger,
  type IRecentWorkspace,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceServiceWire,
  NullLogger,
  Relay,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { workspaceIdFromUri } from '../../storage.js'
import type { RecentWorkspacesMainService } from './recentWorkspacesMainService.js'

export interface IFolderDialog {
  showOpenFolderDialog(): Promise<URI | null>
}

/**
 * Storage capability needed by WorkspaceMainService — extends IStorageService
 * with the main-only `switchWorkspace` / `flush` hooks so the service can
 * coordinate scope swaps when the active folder changes.
 */
export interface IWorkspaceScopedStorage extends IStorageService {
  switchWorkspace(workspaceId: string | null): Promise<void>
  flush(): Promise<void>
}

/**
 * Called by openFolder before swapping this window's workspace. If it returns
 * true, an existing window already has the requested folder open and has been
 * focused; openFolder then aborts without changing this window.
 */
export type OpenFolderInterceptor = (workspaceId: string) => boolean

function makeWorkspace(folder: URI): IWorkspace {
  return { folder, name: basename(folder.fsPath) || folder.fsPath }
}

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class WorkspaceMainService implements IWorkspaceServiceWire, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace: Event<IWorkspace | null> = this._onDidChangeWorkspace.event

  // Recent list is shared across windows; relay the singleton's event so the
  // upstream listener is only held while the renderer is actually subscribed.
  private readonly _recentRelay = new Relay<readonly IRecentWorkspace[]>()
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]> = this._recentRelay.event

  private _current: IWorkspace | null = null
  private _hydrated = false
  private _hydratePromise: Promise<void> | null = null

  constructor(
    private readonly _storage: IWorkspaceScopedStorage,
    private readonly _recents: RecentWorkspacesMainService,
    private readonly _folderDialog: IFolderDialog,
    private readonly _logger: ILogger = new NullLogger(),
    private readonly _onBeforeOpen?: OpenFolderInterceptor,
  ) {
    this._recentRelay.input = _recents.onDidChangeRecent
  }

  /** Synchronous snapshot of this window's current workspace (main-only). */
  get current(): IWorkspace | null {
    return this._current
  }

  private async _hydrate(): Promise<void> {
    if (this._hydrated) return
    if (this._hydratePromise) return this._hydratePromise
    this._hydratePromise = (async () => {
      // Bind the WORKSPACE-scope backend to the current workspace (or detach if
      // none), so the first WORKSPACE reads after startup hit the right file.
      // `_current` is null unless restoreCurrent() was called before hydration.
      try {
        await this._storage.switchWorkspace(
          this._current ? workspaceIdFromUri(this._current.folder.toString()) : null,
        )
      } catch {
        // best-effort; storage layer logs its own errors
      }
      this._logger.debug(
        `hydrate workspace current=${this._current?.folder.toString() ?? '<none>'}`,
      )
      this._hydrated = true
    })()
    return this._hydratePromise
  }

  async getCurrent(): Promise<IWorkspace | null> {
    await this._hydrate()
    return this._current
  }

  getRecent(): Promise<readonly IRecentWorkspace[]> {
    return this._recents.getRecent()
  }

  async openFolder(folder?: URI | UriComponents): Promise<void> {
    let resolved: URI | null
    // JSON.stringify([undefined]) → "[null]" over IPC, so treat null same as undefined.
    if (folder == null) {
      resolved = await this._folderDialog.showOpenFolderDialog()
      if (!resolved) {
        this._logger.info('openFolder cancelled')
        return
      }
    } else {
      resolved = reviveUri(folder)
    }
    await this._hydrate()
    const workspace = makeWorkspace(resolved)
    const workspaceId = workspaceIdFromUri(workspace.folder.toString())
    // If the folder is already open in some window, focus it instead of
    // swapping this window's workspace (VSCode behaviour; also avoids two
    // windows writing the same workspaces/<id>.json concurrently).
    if (this._onBeforeOpen?.(workspaceId)) {
      this._logger.info(`openFolder focused existing window for ${workspace.folder.toString()}`)
      await this._recents.add(workspace)
      return
    }
    // Flush + swap storage scope BEFORE firing onDidChangeWorkspace so
    // subscribers (renderer-side restore contributions) read the new
    // workspace's data, not the previous one's. Best-effort, mirroring
    // switchWorkspace's own flush: a failed final persist of the OUTGOING
    // workspace (e.g. its atomic write raced an external delete) must not
    // abort opening the new folder.
    try {
      await this._storage.flush()
    } catch {
      // proceed with swap regardless
    }
    await this._storage.switchWorkspace(workspaceId)
    this._current = workspace
    this._onDidChangeWorkspace.fire(workspace)
    await this._recents.add(workspace)
    this._logger.info(`openFolder ${workspace.folder.toString()}`)
  }

  async closeFolder(): Promise<void> {
    if (this._current === null) return
    const previous = this._current.folder.toString()
    try {
      await this._storage.flush()
    } catch {
      // best-effort flush; proceed with the swap regardless
    }
    await this._storage.switchWorkspace(null)
    this._current = null
    this._onDidChangeWorkspace.fire(null)
    this._logger.info(`closeFolder ${previous}`)
  }

  clearRecent(): Promise<void> {
    return this._recents.clear()
  }

  removeRecent(folder: URI | UriComponents): Promise<void> {
    return this._recents.remove(reviveUri(folder))
  }

  /**
   * Restore a workspace into this window at startup (multi-window session
   * restore). Marks the service hydrated so a later getCurrent() does not
   * re-run the WORKSPACE-scope swap. Also bumps the shared recent list so a
   * workspace kept open across app restarts (the common case) doesn't go
   * stale relative to folders opened explicitly via Open Folder/Open Recent.
   */
  async restoreCurrent(workspace: IWorkspace): Promise<void> {
    await this._storage.switchWorkspace(workspaceIdFromUri(workspace.folder.toString()))
    this._current = workspace
    this._hydrated = true
    this._onDidChangeWorkspace.fire(workspace)
    await this._recents.add(workspace)
    this._logger.info(`restoreCurrent ${workspace.folder.toString()}`)
  }

  dispose(): void {
    this._onDidChangeWorkspace.dispose()
    this._recentRelay.dispose()
  }
}
