/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Notification-related actions: toggle center, clear all, test notification.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  INotificationService,
  Severity,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { localize, localize2 } from '@universe-editor/platform'

export class ToggleNotificationsCenterAction extends Action2 {
  static readonly ID = 'workbench.action.notifications.toggleList'
  constructor() {
    super({
      id: ToggleNotificationsCenterAction.ID,
      title: localize2('action.notifications.toggleList', 'Toggle Notifications'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const svc = accessor.get(INotificationService)
    // Three-state bell:
    //   1. center open  → close center
    //   2. center closed & toast visible (unread > 0) → just hide the toast
    //   3. center closed & no toast → open center
    if (svc.centerVisible.get()) {
      svc.toggleCenter()
      return
    }
    if (svc.unreadCount.get() > 0) {
      svc.markAllAsRead()
      return
    }
    svc.toggleCenter()
  }
}

export class ClearAllNotificationsAction extends Action2 {
  static readonly ID = 'workbench.action.notifications.clearAll'
  constructor() {
    super({
      id: ClearAllNotificationsAction.ID,
      title: localize2('action.notifications.clearAll', 'Clear All Notifications'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(INotificationService).clearAll()
  }
}

export class TestNotificationAction extends Action2 {
  static readonly ID = 'workbench.action.notifications.test'
  constructor() {
    super({
      id: TestNotificationAction.ID,
      title: localize2('action.notifications.test', 'Test Notification'),
      category: localize2('command.category.developer', 'Developer'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(INotificationService).notify({
      severity: Severity.Info,
      message: localize('action.notifications.test.message', 'This is a test notification.'),
    })
  }
}
