/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reflects the main-process update state machine in the UI (VSCode-style): a
 *  status-bar entry that advances available → downloading → restart, plus
 *  prompt notifications at the download and install decision points. Auto-checks
 *  on startup (and on an interval) unless `update.mode` is `manual`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  INotificationService,
  IStatusBarService,
  IWorkbenchContribution,
  Severity,
  StatusBarAlignment,
  localize,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { IUpdateService, type UpdateState } from '../../shared/ipc/updateService.js'
import { DownloadUpdateAction, InstallUpdateAction } from '../actions/updateActions.js'

export class UpdateContribution extends Disposable implements IWorkbenchContribution {
  private _entry: IStatusBarEntryAccessor | undefined
  private _notifiedAvailable: string | undefined
  private _notifiedDownloaded: string | undefined

  constructor(
    @IUpdateService private readonly _update: IUpdateService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @INotificationService private readonly _notification: INotificationService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
  ) {
    super()
    this._register(this._update.onDidChangeState((state) => this._onState(state)))
    this._register({ dispose: () => this._entry?.dispose() })
    this._scheduleChecks()
  }

  private _scheduleChecks(): void {
    const mode = this._configuration.get<string>('update.mode') ?? 'start'
    if (mode === 'manual') return
    void this._update.checkForUpdates()
    const minutes = this._configuration.get<number>('update.checkIntervalMinutes') ?? 1440
    if (minutes <= 0) return
    const handle = setInterval(() => void this._update.checkForUpdates(), minutes * 60_000)
    this._register({ dispose: () => clearInterval(handle) })
  }

  private _onState(state: UpdateState): void {
    this._renderStatusBar(state)

    if (
      state.status === 'available' &&
      state.version &&
      this._notifiedAvailable !== state.version
    ) {
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

    if (
      state.status === 'downloaded' &&
      state.version &&
      this._notifiedDownloaded !== state.version
    ) {
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
  }

  private _renderStatusBar(state: UpdateState): void {
    const entry = entryForState(state)
    if (!entry) {
      this._entry?.dispose()
      this._entry = undefined
      return
    }
    if (this._entry) this._entry.update(entry)
    else this._entry = this._statusBar.addEntry(entry)
  }
}

export function entryForState(state: UpdateState): IStatusBarEntry | undefined {
  switch (state.status) {
    case 'checking':
      return {
        text: localize('update.checkingShort', 'Checking for updates…'),
        showProgress: 'spinning',
        alignment: StatusBarAlignment.Right,
        priority: 9,
      }
    case 'available':
      return {
        text: localize('update.availableShort', 'Update available'),
        icon: 'sparkle',
        kind: 'prominent',
        tooltip: localize(
          'update.availableTooltip',
          'A new version ({version}) is available — click to download',
          { version: state.version ?? '' },
        ),
        command: DownloadUpdateAction.ID,
        alignment: StatusBarAlignment.Right,
        priority: 9,
      }
    case 'downloading':
      return {
        text: localize('update.downloadingShort', 'Downloading update… {percent}%', {
          percent: state.percent ?? 0,
        }),
        showProgress: 'spinning',
        alignment: StatusBarAlignment.Right,
        priority: 9,
      }
    case 'downloaded':
      return {
        text: localize('update.restartShort', 'Restart to update'),
        icon: 'sparkle',
        kind: 'prominent',
        tooltip: localize(
          'update.downloadedTooltip',
          'Version {version} downloaded — click to restart and install',
          { version: state.version ?? '' },
        ),
        command: InstallUpdateAction.ID,
        alignment: StatusBarAlignment.Right,
        priority: 9,
      }
    default:
      return undefined
  }
}
