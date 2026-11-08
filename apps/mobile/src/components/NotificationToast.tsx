import { useEffect } from 'react'
import type { MobileClient } from '../state/mobileClient.js'
import { sessionRouteKey } from '../state/refs.js'
import { useStore } from '../state/useStore.js'
import { strings } from '../strings.js'

const TOAST_MS = 5_000

export interface NotificationToastProps {
  readonly client: MobileClient
  readonly onOpen: (sessionKey: string, focusPending: boolean) => void
}

/**
 * In-app echo of a foreground `notification` frame. The client suppresses the
 * frame while the matching session page is open; clicking routes there (and to
 * the pending card for permission requests).
 */
export function NotificationToast({ client, onOpen }: NotificationToastProps) {
  const notification = useStore(client.getNotificationStore())

  useEffect(() => {
    if (notification === undefined) return
    const timer = setTimeout(() => client.dismissNotification(), TOAST_MS)
    return () => clearTimeout(timer)
  }, [client, notification])

  if (notification === undefined) return null

  const open = (): void => {
    client.dismissNotification()
    onOpen(sessionRouteKey(notification.ref), notification.kind === 'permission')
  }

  return (
    <div className="notification-toast" role="status" data-testid="notification-toast">
      <button type="button" className="notification-toast__body" onClick={open}>
        <strong className="notification-toast__title">{notification.title}</strong>
        <span className="notification-toast__text">{notification.body}</span>
      </button>
      <button
        type="button"
        className="notification-toast__dismiss"
        aria-label={strings.noticeDismiss}
        onClick={() => client.dismissNotification()}
      >
        ×
      </button>
    </div>
  )
}
