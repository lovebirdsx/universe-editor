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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INotificationService, type INotification } from '@universe-editor/platform'
import {
  NotificationsCenter as NotificationsCenterUI,
  OwnerDocumentProvider,
  findScrollableElement,
  measureRowHeight,
  scrollViewportByRows,
  useFocusRestore,
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

  // The panel's own autoFocus steals focus on mount, so the hand-back target is
  // the element that held it before the center became visible. The panel root is
  // remembered so a close can tell "the center still owned focus" (restore) from
  // "the user moved elsewhere while it was open" (leave it alone) even though
  // the panel is already unmounted by the time the restore runs.
  const panelElRef = useRef<Element | null>(null)
  const doc = workbenchDocumentOrMain(centerDocument)
  useLayoutEffect(() => {
    if (!visible || doc === undefined) return
    panelElRef.current = doc.querySelector('[data-testid="notifications-center"]')
  }, [visible, doc])
  useFocusRestore(visible, {
    targetDocument: doc,
    onlyIfLost: () => panelElRef.current,
  })

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
      scrollViewport: (direction, step) => {
        const root = doc.querySelector<HTMLElement>('[data-testid="notifications-center"]')
        const list = doc.querySelector<HTMLElement>('[data-testid="notifications-center-list"]')
        const row =
          list?.querySelector<HTMLElement>('[data-testid="notification-center-item"]') ?? null
        scrollViewportByRows(
          findScrollableElement(list ?? root),
          measureRowHeight(row),
          direction,
          step,
        )
      },
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
    [activeIndex, count, doc, moveBy, ordered, service],
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
