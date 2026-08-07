/*---------------------------------------------------------------------------------------------
 *  NotificationsToast — presentational right-bottom toast stack. Pure: receives
 *  the notifications to show plus dismiss/cancel callbacks. Filtering, the
 *  observable subscription and the Portal live in the host wrapper.
 *--------------------------------------------------------------------------------------------*/

import type { INotification } from '@universe-editor/platform'
import { Severity, localize } from '@universe-editor/platform'
import { notificationSeverityClass, notificationSeverityIcon } from './severityIcon.js'
import styles from './NotificationsToast.module.css'

export interface NotificationsToastProps {
  /** Already filtered/sliced by the host (e.g. unread, max 5). */
  readonly notifications: readonly INotification[]
  readonly onDismiss: (id: string) => void
  readonly onCancelProgress: (id: string) => void
}

function severityClass(severity: Severity): string {
  return `${styles['toast']} ${styles[notificationSeverityClass(severity)] ?? ''}`
}

export function NotificationsToast({
  notifications,
  onDismiss,
  onCancelProgress,
}: NotificationsToastProps) {
  if (notifications.length === 0) return null

  return (
    <div className={styles['container']} data-testid="notifications-toast-container">
      {notifications.map((n) => (
        <div key={n.id} className={severityClass(n.severity)} data-testid="notification-toast-item">
          <span className={styles['icon']}>{notificationSeverityIcon(n.severity)}</span>
          <div className={styles['body']}>
            <p className={styles['message']}>{n.message}</p>
            {n.progress !== undefined && !n.progress.done && (
              <div className={styles['progressRow']}>
                <div className={styles['progress']}>
                  {n.progress.increment !== undefined ? (
                    <div
                      className={styles['progressBarDeterminate']}
                      style={{ width: `${Math.min(100, Math.max(0, n.progress.increment))}%` }}
                      data-testid="notification-progress-determinate"
                    />
                  ) : (
                    <div className={styles['progressBar']} />
                  )}
                </div>
                {n.cancellable === true && (
                  <button
                    className={styles['cancelBtn']}
                    onClick={() => onCancelProgress(n.id)}
                    type="button"
                    data-testid="notification-cancel-btn"
                  >
                    {localize('common.cancel', 'Cancel')}
                  </button>
                )}
              </div>
            )}
            {n.actions !== undefined && n.actions.length > 0 && (
              <div className={styles['actions']}>
                {n.actions.map((action) => (
                  <button
                    key={action.label}
                    className={styles['actionBtn']}
                    onClick={() => action.run()}
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {n.sticky && (
            <button
              aria-label={localize('notification.dismissAria', 'Dismiss notification')}
              className={styles['closeBtn']}
              onClick={() => onDismiss(n.id)}
              type="button"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
