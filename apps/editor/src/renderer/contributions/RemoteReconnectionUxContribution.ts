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
  ILoggerService,
  INotificationService,
  IWorkspaceService,
  Severity,
  createNamedLogger,
  localize,
  type ILogger,
  type INotificationHandle,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  IRemoteStatusService,
  type RemoteConnectionStatusDto,
} from '../../shared/ipc/remoteStatusService.js'
import { CloseConnectionAction, RetryConnectionAction } from '../actions/remoteActions.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'

const RECONNECT_NOTIFY_DELAY_MS = 800

export class RemoteReconnectionUxContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private _progressHandle: INotificationHandle | undefined
  private _failedHandle: INotificationHandle | undefined
  private _failedAuthority: string | undefined
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined
  private _reconnecting = false

  constructor(
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @INotificationService private readonly _notification: INotificationService,
    @ICommandService private readonly _commands: ICommandService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteReconnectUx',
      name: 'Remote Reconnect UX',
    })

    this._register(this._remoteStatus.onDidChangeState((status) => this._onState(status)))
    this._register(this._workspace.onDidChangeWorkspace(() => this._onWorkspaceChanged()))
    this._register({
      dispose: () => {
        this._clearDebounce()
        this._dismissProgress()
        this._dismissFailed()
      },
    })
  }

  private _currentAuthority(): string | undefined {
    return currentRemoteAuthority(this._workspace.current)
  }

  private _onWorkspaceChanged(): void {
    // The authority changed (switch / close folder): reset the reconnect UX so
    // a stale "reconnecting"/"failed" state never leaks into the next workspace.
    this._reconnecting = false
    this._clearDebounce()
    this._dismissProgress()
    this._dismissFailed()
  }

  private _onState(status: RemoteConnectionStatusDto): void {
    if (status.authority !== this._currentAuthority()) return
    switch (status.state) {
      case 'reconnecting':
        this._reconnecting = true
        this._scheduleReconnectNotification(status.authority)
        break
      case 'connected':
        // A real recovery re-arms the failed-toast guard for a future failure.
        this._dismissFailed()
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
        this._notifyFailed(status.authority, status.errorMessage)
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

  private _notifyFailed(authority: string, errorMessage?: string): void {
    // One failed toast per authority: the main-side failed → idle → bring-up
    // loop keeps firing `failed`, but a second identical toast would just stack.
    // The guard is cleared on `connected` (real recovery), on Retry, and on a
    // workspace switch — never on a plain user dismissal, so an X'd toast does
    // not re-pop while the loop keeps failing.
    if (this._failedAuthority === authority) {
      this._logger.debug(`[remote:${authority}] suppressed duplicate failed toast`)
      return
    }
    this._failedAuthority = authority
    this._logger.warn(
      `[remote:${authority}] reconnection failed${errorMessage !== undefined ? `: ${errorMessage}` : ''}`,
    )
    const message =
      errorMessage === undefined
        ? localize('remote.reconnect.failed', 'Cannot reconnect to {authority}.', { authority })
        : localize('remote.reconnect.failed.detail', 'Cannot reconnect to {authority}. {error}', {
            authority,
            error: errorMessage,
          })
    const handle = this._notification.notify({
      severity: Severity.Error,
      message,
      actions: [
        {
          label: localize('remote.reconnect.retry', 'Retry'),
          run: () => {
            // Retry re-arms the guard so a fresh failure can surface a new toast.
            this._dismissFailed()
            void this._commands.executeCommand(RetryConnectionAction.ID, authority)
          },
        },
        {
          label: localize('remote.reconnect.closeRemote', 'Close Remote Workspace'),
          isSecondary: true,
          run: () => void this._commands.executeCommand(CloseConnectionAction.ID, authority),
        },
      ],
    })
    this._failedHandle = handle
  }

  private _dismissFailed(): void {
    this._failedAuthority = undefined
    if (this._failedHandle !== undefined) {
      this._notification.dismiss(this._failedHandle.id)
      this._failedHandle.dispose()
      this._failedHandle = undefined
    }
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
