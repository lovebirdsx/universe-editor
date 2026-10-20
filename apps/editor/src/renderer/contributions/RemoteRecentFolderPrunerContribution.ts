/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Remote counterpart to the local open-time check in main (see
 *  folderOpenGuard.ts): a remote folder is never probed before the window
 *  opens — that would force a connection and could misread a transient failure
 *  as "missing". Once the window is up, prune the recent entry only when the
 *  remote file system authoritatively answers ENOENT (VSCode's
 *  recentRemoteFolderPruner behaviour; ENOTDIR maps to FILE_OTHER_ERROR there
 *  and must keep the entry).
 *--------------------------------------------------------------------------------------------*/

import {
  createNamedLogger,
  Disposable,
  IFileService,
  ILoggerService,
  IWorkspaceService,
  REMOTE_SCHEME,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'

export function isMissingRemoteFolderError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === 'ENOENT'
}

export class RemoteRecentFolderPrunerContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger
  private _disposed = false
  private _inFlightKey: string | null = null

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteRecentPruner',
      name: 'Remote Recent Pruner',
    })
    // Startup hydration sees restoreCurrent's workspace; the event covers later
    // same-window switches (a new window gets its own renderer and hits the
    // whenReady path instead).
    void this._workspace.whenReady.then(() => this._schedule())
    this._register(this._workspace.onDidChangeWorkspace(() => this._schedule()))
  }

  private _schedule(): void {
    void this._pruneCurrent().catch((err) => this._logger.warn('remote recent prune failed', err))
  }

  private async _pruneCurrent(): Promise<void> {
    if (this._disposed) return
    const current = this._workspace.current
    if (!current || current.folder.scheme !== REMOTE_SCHEME) return
    const folder = current.folder
    const key = folder.toString()
    // whenReady and the initial workspace-change event can fire back to back for
    // the same folder; don't pay for two remote round trips.
    if (this._inFlightKey === key) return
    this._inFlightKey = key
    try {
      try {
        await this._fileService.stat(folder)
        return
      } catch (err) {
        if (!isMissingRemoteFolderError(err)) {
          this._logger.debug(
            `remote recent kept ${key} code=${String((err as { code?: unknown })?.code)}`,
          )
          return
        }
      }
      // The user may have switched workspaces while the remote stat was in flight.
      if (this._disposed || this._workspace.current?.folder.toString() !== key) return
      try {
        await this._workspace.removeRecent(folder)
        this._logger.info(`removed missing remote recent ${key}`)
      } catch (err) {
        this._logger.warn(`remove missing remote recent failed ${key}`, err)
      }
    } finally {
      if (this._inFlightKey === key) this._inFlightKey = null
    }
  }

  override dispose(): void {
    this._disposed = true
    super.dispose()
  }
}
