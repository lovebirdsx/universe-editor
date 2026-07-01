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
  IWorkbenchContribution,
  Severity,
  localize,
} from '@universe-editor/platform'
import { IUpdateService, type UpdateState } from '../../shared/ipc/updateService.js'

export class UpdateContribution extends Disposable implements IWorkbenchContribution {
  private _notifiedAvailable: string | undefined
  private _notifiedDownloaded: string | undefined

  constructor(
    @IUpdateService private readonly _update: IUpdateService,
    @INotificationService private readonly _notification: INotificationService,
  ) {
    super()
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
        return
      case 'idle':
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
        return
    }
  }
}
