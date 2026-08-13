/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteReconnectionUxContribution — surfaces transparent reconnection as
 *  notifications (VSCode's RemoteAgentConnectionStatusListener, simplified):
 *    - reconnecting  → progress notification (debounced 800ms so a <1s blip
 *      never flashes a toast), kept visible until the state settles.
 *    - connected     → dismiss the progress notification + a brief "Reconnected"
 *      info toast (auto-dismisses).
 *    - failed        → error toast with [Retry] and [Close Remote Workspace].
 *  Only reacts to state changes for the CURRENT remote-ssh workspace authority.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  INotificationService,
  IWorkspaceService,
  REMOTE_SCHEME,
  Severity,
  localize,
  type INotificationHandle,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../shared/ipc/remoteStatusService.js'
import { CloseConnectionAction, RetryConnectionAction } from '../actions/remoteActions.js'

const RECONNECT_NOTIFY_DELAY_MS = 800

export class RemoteReconnectionUxContribution extends Disposable implements IWorkbenchContribution {
  private _progressHandle: INotificationHandle | undefined
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _reconnecting = false

  constructor(
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @INotificationService private readonly _notification: INotificationService,
    @ICommandService private readonly _commands: ICommandService,
  ) {
    super()

    this._register(this._remoteStatus.onDidChangeState((status) => this._onState(status)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._onWorkspaceChanged()))
    this._register({
      dispose: () => {
        this._clearDebounce()
        this._dismissProgress()
      },
    })
  }

  private _currentAuthority(): string | undefined {
    const folder = this._workspace.current?.folder
    return folder !== undefined && folder.scheme === REMOTE_SCHEME ? folder.authority : undefined
  }

  private _onWorkspaceChanged(): void {
    // The authority changed (switch / close folder): reset the reconnect UX so
    // a stale "reconnecting" state never leaks into the next workspace.
    this._reconnecting = false
    this._clearDebounce()
    this._dismissProgress()
  }

  private _onState(status: RemoteConnectionStatusDto): void {
    if (status.authority !== this._currentAuthority()) return
    switch (status.state) {
      case 'reconnecting':
        this._reconnecting = true
        this._scheduleReconnectNotification(status.authority)
        break
      case 'connected':
        if (this._reconnecting) {
          this._reconnecting = false
          this._clearDebounce()
          this._dismissProgress()
          this._notifyReconnected(status.authority)
        }
        break
      case 'failed':
        this._reconnecting = false
        this._clearDebounce()
        this._dismissProgress()
        this._notifyFailed(status.authority)
        break
      default:
        break
    }
  }

  private _scheduleReconnectNotification(authority: string): void {
    this._clearDebounce()
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined
      if (this._currentAuthority() !== authority) return
      this._dismissProgress()
      const handle = this._notification.notify({
        severity: Severity.Info,
        message: localize(
          'remote.reconnect.lost',
          'Connection to {authority} lost. Reconnecting...',
          {
            authority,
          },
        ),
        sticky: true,
      })
      // An indeterminate progress bar keeps the toast visibly "working" until the
      // state settles (the message above already carries the text).
      handle.progress.report({})
      this._progressHandle = handle
    }, RECONNECT_NOTIFY_DELAY_MS)
  }

  private _notifyReconnected(authority: string): void {
    this._notification.notify({
      severity: Severity.Info,
      message: localize('remote.reconnect.reconnected', 'Reconnected to {authority}.', {
        authority,
      }),
    })
  }

  private _notifyFailed(authority: string): void {
    this._notification.notify({
      severity: Severity.Error,
      message: localize('remote.reconnect.failed', 'Cannot reconnect to {authority}.', {
        authority,
      }),
      actions: [
        {
          label: localize('remote.reconnect.retry', 'Retry'),
          run: () => void this._commands.executeCommand(RetryConnectionAction.ID, authority),
        },
        {
          label: localize('remote.reconnect.closeRemote', 'Close Remote Workspace'),
          isSecondary: true,
          run: () => void this._commands.executeCommand(CloseConnectionAction.ID, authority),
        },
      ],
    })
  }

  private _clearDebounce(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = undefined
    }
  }

  private _dismissProgress(): void {
    if (this._progressHandle !== undefined) {
      this._notification.dismiss(this._progressHandle.id)
      this._progressHandle.dispose()
      this._progressHandle = undefined
    }
  }
}
