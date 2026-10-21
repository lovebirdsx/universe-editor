/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to INotificationService and portals the presentational
 *  NotificationsToast (from workbench-ui), one stack per origin window. Matches
 *  VSCode, where each workbench window owns its notification service.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService, type INotification } from '@universe-editor/platform'
import {
  NotificationsToast as NotificationsToastUI,
  OwnerDocumentProvider,
} from '@universe-editor/workbench-ui'
import type { IDocumentAwareNotificationService } from '../../services/notification/notificationDocumentRouting.js'
import { workbenchDocumentOrMain } from '../../services/windows/workbenchDocuments.js'
import { useObservable, useService } from '../useService.js'

const MAX_TOASTS_PER_WINDOW = 5
const documentKeys = new WeakMap<Document, number>()
let nextDocumentKey = 0

function keyForDocument(doc: Document): number {
  const existing = documentKeys.get(doc)
  if (existing !== undefined) return existing
  const key = nextDocumentKey++
  documentKeys.set(doc, key)
  return key
}

export function NotificationsToast() {
  const service = useService(INotificationService) as IDocumentAwareNotificationService
  const notifications = useObservable(service.notifications)
  const origins = useObservable(service.notificationOrigins)

  const groups = new Map<Document, INotification[]>()
  for (const notification of notifications) {
    if (notification.read) continue
    const doc = workbenchDocumentOrMain(origins.get(notification.id))
    if (!doc) continue
    const group = groups.get(doc)
    if (group) group.push(notification)
    else groups.set(doc, [notification])
  }

  if (groups.size === 0) return null

  return (
    <>
      {[...groups].map(([doc, items]) =>
        createPortal(
          <OwnerDocumentProvider targetDocument={doc}>
            <NotificationsToastUI
              notifications={items.slice(0, MAX_TOASTS_PER_WINDOW)}
              onDismiss={(id) => service.dismiss(id)}
              onCancelProgress={(id) => service.cancelProgress(id)}
            />
          </OwnerDocumentProvider>,
          doc.body,
          keyForDocument(doc),
        ),
      )}
    </>
  )
}
