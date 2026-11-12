import { useEffect, useRef } from 'react'
import { strings } from '../strings.js'

export type DeliveryToastTone = 'info' | 'danger'

export interface DeliveryAlertToastProps {
  readonly title: string
  readonly body: string
  readonly tone: DeliveryToastTone
  readonly onDismiss: () => void
  readonly onOpenInbox: () => void
}

const TOAST_MS = 5_000

export function DeliveryAlertToast({
  title,
  body,
  tone,
  onDismiss,
  onOpenInbox,
}: DeliveryAlertToastProps) {
  // The parent re-renders on every inbox update; a changing callback identity
  // must not restart the auto-dismiss timer.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), TOAST_MS)
    return () => clearTimeout(timer)
  }, [title, body, tone])

  return (
    <div
      className={`notification-toast delivery-toast delivery-toast--${tone}`}
      role="status"
      data-testid="delivery-notice-toast"
    >
      <button type="button" className="notification-toast__body" onClick={onOpenInbox}>
        <strong className="notification-toast__title">{title}</strong>
        <span className="notification-toast__text">{body}</span>
      </button>
      <button
        type="button"
        className="notification-toast__dismiss"
        aria-label={strings.noticeDismiss}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}
