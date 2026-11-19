/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Host wrapper: subscribes to INotificationService and portals the presentational
 *  NotificationsCenter (from workbench-ui) when the center is visible.
 *
 *  The center belongs to the window it was opened in and lists that window's
 *  notifications (plus restored ones, which have no origin and live in main).
 *  It also registers an overlay Vim surface: j/k move the row cursor, Enter runs
 *  the focused notification's primary action, d d / Delete dismiss it, Esc
 *  closes the center.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INotificationService, type INotification } from '@universe-editor/platform'
import {
  NotificationsCenter as NotificationsCenterUI,
  OwnerDocumentProvider,
  useVimSurface,
  useVimSurfaceKey,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import type { IDocumentAwareNotificationService } from '../../services/notification/notificationDocumentRouting.js'
import { workbenchDocumentOrMain } from '../../services/windows/workbenchDocuments.js'
import { useObservable, useService } from '../useService.js'

const NOTIFICATION_ROWS_PER_PAGE = 5

export function NotificationsCenter() {
  const service = useService(INotificationService) as IDocumentAwareNotificationService
  const visible = useObservable(service.centerVisible)
  const notifications = useObservable(service.notifications)
  const origins = useObservable(service.notificationOrigins)
  const centerDocument = useObservable(service.centerDocument)

  // The panel's own autoFocus effect steals focus on mount, so the hand-back
  // target has to be read during render (before child effects run). The snapshot
  // is never consumed by a cleanup: dev's StrictMode replays mount effects and a
  // cleanup-time restore would eat it before the real close.
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const wasVisibleRef = useRef(false)
  const doc = workbenchDocumentOrMain(centerDocument)
  if (visible && !wasVisibleRef.current && doc !== undefined) {
    const active = doc.activeElement
    const candidate = active as HTMLElement | null
    restoreFocusRef.current =
      candidate !== null &&
      candidate !== doc.body &&
      typeof candidate.focus === 'function' &&
      candidate.closest?.('[data-testid="notifications-center"]') === null
        ? candidate
        : null
  }
  wasVisibleRef.current = visible

  // Close (Esc / × / the toggle command) drops focus to <body> because the
  // panel took it on open. Hand it back only when the panel still owned focus;
  // a user who moved elsewhere keeps the new focus.
  useEffect(() => {
    if (visible) return
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    if (target === null) return
    const targetDocument = target.ownerDocument
    const active = targetDocument.activeElement
    if (active !== null && active !== targetDocument.body && active !== target) return
    if (target.isConnected) target.focus()
  }, [visible])

  if (!visible) return null
  if (!doc) return null

  const visibleNotifications = notifications.filter(
    (n) => workbenchDocumentOrMain(origins.get(n.id)) === doc,
  )

  return createPortal(
    <OwnerDocumentProvider targetDocument={doc}>
      <NotificationsCenterSurface
        doc={doc}
        notifications={visibleNotifications}
        service={service}
      />
    </OwnerDocumentProvider>,
    doc.body,
  )
}

interface NotificationsCenterSurfaceProps {
  readonly doc: Document
  readonly notifications: readonly INotification[]
  readonly service: IDocumentAwareNotificationService
}

function NotificationsCenterSurface({
  doc,
  notifications,
  service,
}: NotificationsCenterSurfaceProps) {
  const [focusedIndex, setFocusedIndex] = useState(0)
  // Rendered order is newest-first, matching the presentational component.
  const ordered = useMemo(() => [...notifications].reverse(), [notifications])
  const count = ordered.length
  const activeIndex = count === 0 ? -1 : Math.min(Math.max(focusedIndex, 0), count - 1)
  const surfaceKey = useVimSurfaceKey('overlay', 'notifications')

  const moveBy = useCallback(
    (delta: number) => {
      if (count === 0) return
      setFocusedIndex((previous) => {
        const base = previous < 0 ? 0 : previous
        return Math.max(0, Math.min(count - 1, base + delta))
      })
    },
    [count],
  )

  const actions = useMemo<IVimSurfaceActions>(
    () => ({
      move: (direction, step) => moveBy((direction === 'down' ? 1 : -1) * Math.max(1, step)),
      first: () => setFocusedIndex(0),
      last: () => {
        if (count > 0) setFocusedIndex(count - 1)
      },
      page: (direction, step) =>
        moveBy((direction === 'down' ? 1 : -1) * NOTIFICATION_ROWS_PER_PAGE * Math.max(1, step)),
      activate: () => {
        const notification = ordered[activeIndex]
        if (notification === undefined) return
        const primary = notification.actions?.[0]
        if (primary !== undefined) {
          primary.run()
          return
        }
        if (notification.cancellable === true && notification.progress?.done !== true) {
          service.cancelProgress(notification.id)
        }
      },
      remove: () => {
        const notification = ordered[activeIndex]
        if (notification !== undefined) service.dismiss(notification.id)
      },
      escape: () => service.toggleCenter(),
    }),
    [activeIndex, count, moveBy, ordered, service],
  )

  useVimSurface({
    id: 'notifications-center',
    kind: 'overlay',
    focus: 'within',
    getElement: () => doc.querySelector<HTMLElement>('[data-testid="notifications-center"]'),
    getSurfaceKey: () => surfaceKey,
    defaultMode: 'normal',
    actions,
  })

  return (
    <NotificationsCenterUI
      notifications={notifications}
      focusedIndex={activeIndex}
      onFocusChange={setFocusedIndex}
      autoFocus
      onDismiss={(id) => service.dismiss(id)}
      onCancelProgress={(id) => service.cancelProgress(id)}
      onClearAll={() => service.clearAll()}
      onClose={() => service.toggleCenter()}
    />
  )
}
