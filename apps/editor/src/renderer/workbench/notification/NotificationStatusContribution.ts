/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StatusBar bell icon + unread badge. AfterRestore — needs the status bar to be live.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  autorun,
  localize,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'

export class NotificationStatusContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined

  constructor(
    @INotificationService private readonly _notificationService: INotificationService,
    @IStatusBarService private readonly _statusBarService: IStatusBarService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const count = _notificationService.unreadCount.read(r)
        this._update(count)
      }),
    )

    this._register({ dispose: () => this._accessor?.dispose() })
  }

  private _update(count: number): void {
    const hasUnread = count > 0
    const tooltip = hasUnread
      ? `${count} unread notification(s)`
      : localize('status.notifications', 'Notifications')
    const entry: IStatusBarEntry = hasUnread
      ? {
          text: String(count),
          icon: 'bell',
          kind: 'prominent',
          tooltip,
          command: 'workbench.action.notifications.toggleList',
          alignment: StatusBarAlignment.Right,
          priority: 10,
        }
      : {
          text: '',
          icon: 'bell',
          tooltip,
          command: 'workbench.action.notifications.toggleList',
          alignment: StatusBarAlignment.Right,
          priority: 10,
        }

    if (this._accessor !== undefined) {
      this._accessor.update(entry)
    } else {
      this._accessor = this._statusBarService.addEntry(entry)
    }
  }
}
