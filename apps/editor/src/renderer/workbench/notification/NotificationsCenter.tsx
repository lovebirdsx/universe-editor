/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to INotificationService and portals the presentational
 *  NotificationsCenter (from workbench-ui) when the center is visible.
 *
 *  The center belongs to the window it was opened in and lists that window's
 *  notifications (plus restored ones, which have no origin and live in main).
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService } from '@universe-editor/platform'
import {
  NotificationsCenter as NotificationsCenterUI,
  OwnerDocumentProvider,
} from '@universe-editor/workbench-ui'
import type { IDocumentAwareNotificationService } from '../../services/notification/notificationDocumentRouting.js'
import { workbenchDocumentOrMain } from '../../services/windows/workbenchDocuments.js'
import { useObservable, useService } from '../useService.js'

export function NotificationsCenter() {
  const service = useService(INotificationService) as IDocumentAwareNotificationService
  const visible = useObservable(service.centerVisible)
  const notifications = useObservable(service.notifications)
  const origins = useObservable(service.notificationOrigins)
  const centerDocument = useObservable(service.centerDocument)

  if (!visible) return null
  const doc = workbenchDocumentOrMain(centerDocument)
  if (!doc) return null

  const visibleNotifications = notifications.filter(
    (n) => workbenchDocumentOrMain(origins.get(n.id)) === doc,
  )

  return createPortal(
    <OwnerDocumentProvider targetDocument={doc}>
      <NotificationsCenterUI
        notifications={visibleNotifications}
        onDismiss={(id) => service.dismiss(id)}
        onCancelProgress={(id) => service.cancelProgress(id)}
        onClearAll={() => service.clearAll()}
        onClose={() => service.toggleCenter()}
      />
    </OwnerDocumentProvider>,
    doc.body,
  )
}
