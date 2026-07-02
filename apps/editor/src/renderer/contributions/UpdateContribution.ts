/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Surfaces the main-process update state as notifications at the key decision
 *  points (VSCode-style): a prompt to download when a version becomes available, a
 *  sticky prompt to restart once it's downloaded, and — only for user-initiated
 *  (explicit) checks — an "up to date" / "check failed" result. The always-visible
 *  indicator lives in the title bar (UpdateIndicator); scheduling lives in the main
 *  process (UpdateMainService), so this contribution is purely reactive.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IStatusBarService,
  IWorkbenchContribution,
  Severity,
  StatusBarAlignment,
  localize,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { IUpdateService, type UpdateState } from '../../shared/ipc/updateService.js'
import { DownloadUpdateAction, InstallUpdateAction } from '../actions/updateActions.js'

export class UpdateContribution extends Disposable implements IWorkbenchContribution {
  private _notifiedAvailable: string | undefined
  private _notifiedDownloaded: string | undefined
  private _statusEntry: IStatusBarEntryAccessor | undefined

  constructor(
    @IUpdateService private readonly _update: IUpdateService,
    @INotificationService private readonly _notification: INotificationService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
  ) {
    super()
    this._register({ dispose: () => this._hideStatusEntry() })
    this._register(this._update.onDidChangeState((state) => this._onState(state)))
    void this._update.getState().then((state) => this._onState(state))
  }

  private _onState(state: UpdateState): void {
    switch (state.type) {
      case 'available':
        if (this._notifiedAvailable !== state.version) {
          this._notifiedAvailable = state.version
          this._notification.notify({
            severity: Severity.Info,
            message: localize('update.availableMsg', 'A new version ({version}) is available.', {
              version: state.version,
            }),
            actions: [
              {
                label: localize('update.download', 'Download'),
                run: () => void this._update.downloadUpdate(),
              },
              { label: localize('update.later', 'Later'), isSecondary: true, run: () => {} },
            ],
          })
        }
        this._showStatusEntry('available', state.version)
        return
      case 'downloaded':
        if (this._notifiedDownloaded !== state.version) {
          this._notifiedDownloaded = state.version
          this._notification.notify({
            severity: Severity.Info,
            sticky: true,
            message: localize('update.downloadedMsg', 'Version {version} is ready to install.', {
              version: state.version,
            }),
            actions: [
              {
                label: localize('update.restartNow', 'Restart Now'),
                run: () => void this._update.quitAndInstall(),
              },
              { label: localize('update.later', 'Later'), isSecondary: true, run: () => {} },
            ],
          })
        }
        this._showStatusEntry('downloaded', state.version)
        return
      case 'idle':
        this._hideStatusEntry()
        // Only user-initiated checks announce their (quiet) outcome.
        if (!state.explicit) return
        if (state.notAvailable) {
          this._notification.notify({
            severity: Severity.Info,
            message: localize(
              'update.upToDate',
              'You are running the latest version ({version}).',
              { version: state.currentVersion },
            ),
          })
        } else if (state.error !== undefined) {
          this._notification.notify({
            severity: Severity.Warning,
            message: localize('update.checkFailed', 'Could not check for updates: {error}', {
              error: state.error,
            }),
          })
        }
        return
      default:
        this._hideStatusEntry()
        return
    }
  }

  private _showStatusEntry(type: 'available' | 'downloaded', version: string): void {
    const isDownloaded = type === 'downloaded'
    const entry = {
      text: isDownloaded
        ? localize('update.statusbar.downloaded', 'Restart to install')
        : localize('update.statusbar.available', 'Update available'),
      tooltip: isDownloaded
        ? localize(
            'update.statusbar.downloaded.tooltip',
            'Version {version} downloaded — click to restart and install',
            { version },
          )
        : localize(
            'update.statusbar.available.tooltip',
            'Version {version} is available — click to download',
            { version },
          ),
      kind: isDownloaded ? ('prominent' as const) : ('default' as const),
      command: isDownloaded ? InstallUpdateAction.ID : DownloadUpdateAction.ID,
      alignment: StatusBarAlignment.Left,
      priority: 300,
    }
    if (this._statusEntry) {
      this._statusEntry.update(entry)
    } else {
      this._statusEntry = this._statusBar.addEntry(entry)
    }
  }

  private _hideStatusEntry(): void {
    this._statusEntry?.dispose()
    this._statusEntry = undefined
  }
}
