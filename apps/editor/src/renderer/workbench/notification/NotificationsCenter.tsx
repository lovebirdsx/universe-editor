/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to INotificationService and portals the presentational
 *  NotificationsCenter (from workbench-ui) when the center is visible.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService } from '@universe-editor/platform'
import { NotificationsCenter as NotificationsCenterUI } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'

export function NotificationsCenter() {
  const service = useService(INotificationService)
  const visible = useObservable(service.centerVisible)
  const notifications = useObservable(service.notifications)

  if (!visible) return null

  return createPortal(
    <NotificationsCenterUI
      notifications={notifications}
      onDismiss={(id) => service.dismiss(id)}
      onCancelProgress={(id) => service.cancelProgress(id)}
      onClearAll={() => service.clearAll()}
      onClose={() => service.toggleCenter()}
    />,
    document.body,
  )
}
