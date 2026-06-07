/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to INotificationService and portals the presentational
 *  NotificationsToast (from workbench-ui) showing unread notifications (max 5).
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService } from '@universe-editor/platform'
import { NotificationsToast as NotificationsToastUI } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'

export function NotificationsToast() {
  const service = useService(INotificationService)
  const notifications = useObservable(service.notifications)
  const toShow = notifications.filter((n) => !n.read).slice(0, 5)

  if (toShow.length === 0) return null

  return createPortal(
    <NotificationsToastUI
      notifications={toShow}
      onDismiss={(id) => service.dismiss(id)}
      onCancelProgress={(id) => service.cancelProgress(id)}
    />,
    document.body,
  )
}
