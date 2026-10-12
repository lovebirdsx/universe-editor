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

type StatusEntryType = 'available' | 'downloading' | 'downloaded'

/**
 * Status-bar wording. `downloading` is only ever shown for an unattended important
 * download — a normal one is already visible in the title-bar indicator, and a status
 * entry that re-renders on every progress tick would be pure noise.
 */
function statusEntryContent(
  type: StatusEntryType,
  version: string,
  important: boolean,
): { text: string; tooltip: string } {
  if (type === 'downloading') {
    const text = localize('update.important.downloading', 'Downloading an important update…')
    return { text, tooltip: text }
  }
  if (type === 'downloaded') {
    return important
      ? {
          text: localize('update.important.downloadedLabel', 'Restart to install important update'),
          tooltip: localize(
            'update.important.downloadedTooltip',
            'Important update {version} downloaded — click to restart and install',
            { version },
          ),
        }
      : {
          text: localize('update.statusbar.downloaded', 'Restart to install'),
          tooltip: localize(
            'update.statusbar.downloaded.tooltip',
            'Version {version} downloaded — click to restart and install',
            { version },
          ),
        }
  }
  return important
    ? {
        text: localize('update.important.statusbar', 'Important update available'),
        tooltip: localize(
          'update.important.statusbar.tooltip',
          'Important update {version} is available — click to download',
          { version },
        ),
      }
    : {
        text: localize('update.statusbar.available', 'Update available'),
        tooltip: localize(
          'update.statusbar.available.tooltip',
          'Version {version} is available — click to download',
          { version },
        ),
      }
}

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
      case 'available': {
        const important = state.urgency === 'important'
        // A silent download is already under way: a prompt whose primary action would
        // be a no-op is worse than no prompt. If that download fails, main republishes
        // `available` without the flag and the prompt does appear then.
        if (!state.autoDownload && this._notifiedAvailable !== state.version) {
          this._notifiedAvailable = state.version
          this._notification.notify({
            severity: important ? Severity.Warning : Severity.Info,
            message: important
              ? localize(
                  'update.important.availableMsg',
                  'An important update ({version}) is available — please update soon.',
                  { version: state.version },
                )
              : localize('update.availableMsg', 'A new version ({version}) is available.', {
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
        this._showStatusEntry('available', state.version, important)
        return
      }
      case 'downloading':
        // A normal download is already visible in the title-bar indicator; only the
        // unattended one — which the user never asked for — needs a status-bar sign.
        if (state.urgency === 'important') {
          this._showStatusEntry('downloading', state.version, true)
        } else {
          this._hideStatusEntry()
        }
        return
      case 'downloaded': {
        const important = state.urgency === 'important'
        if (this._notifiedDownloaded !== state.version) {
          this._notifiedDownloaded = state.version
          this._notification.notify({
            severity: important ? Severity.Warning : Severity.Info,
            sticky: true,
            message: important
              ? localize(
                  'update.important.downloadedMsg',
                  'Important update {version} is ready — restart to install it.',
                  { version: state.version },
                )
              : localize('update.downloadedMsg', 'Version {version} is ready to install.', {
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
        this._showStatusEntry('downloaded', state.version, important)
        return
      }
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

  /**
   * `kind: 'prominent'` stays reserved for states that need the user to click
   * something. A download already running only needs to be noticeable, so it keeps
   * the default kind — otherwise it competes with the restart prompt it precedes.
   */
  private _showStatusEntry(type: StatusEntryType, version: string, important: boolean): void {
    const entry = {
      ...statusEntryContent(type, version, important),
      kind: type === 'downloaded' ? ('prominent' as const) : ('default' as const),
      command: type === 'downloaded' ? InstallUpdateAction.ID : DownloadUpdateAction.ID,
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
