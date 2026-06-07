/*---------------------------------------------------------------------------------------------
 *  NotificationsCenter — presentational notification center panel. Pure: receives
 *  notifications plus dismiss/cancel/clear/close callbacks. Visibility, the
 *  observable subscription and the Portal live in the host wrapper.
 *--------------------------------------------------------------------------------------------*/

import type { INotification } from '@universe-editor/platform'
import { Severity } from '@universe-editor/platform'
import styles from './NotificationsCenter.module.css'

export interface NotificationsCenterProps {
  readonly notifications: readonly INotification[]
  readonly onDismiss: (id: string) => void
  readonly onCancelProgress: (id: string) => void
  readonly onClearAll: () => void
  readonly onClose: () => void
}

function severityIcon(severity: Severity): string {
  if (severity === Severity.Error) return '✕'
  if (severity === Severity.Warning) return '⚠'
  return 'ℹ'
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function NotificationsCenter({
  notifications,
  onDismiss,
  onCancelProgress,
  onClearAll,
  onClose,
}: NotificationsCenterProps) {
  // Newest first.
  const items = [...notifications].reverse()

  return (
    <div className={styles['overlay']} data-testid="notifications-center">
      <div className={styles['header']}>
        <span className={styles['title']}>Notifications</span>
        {notifications.length > 0 && (
          <button className={styles['clearBtn']} onClick={() => onClearAll()} type="button">
            Clear All
          </button>
        )}
        <button
          aria-label="Close notification center"
          className={styles['closeBtn']}
          onClick={() => onClose()}
          type="button"
        >
          ×
        </button>
      </div>
      <div className={styles['list']}>
        {items.length === 0 ? (
          <div className={styles['empty']}>No notifications</div>
        ) : (
          items.map((n) => (
            <div
              key={n.id}
              className={n.read ? styles['item'] : `${styles['item']} ${styles['unread']}`}
              data-testid="notification-center-item"
            >
              <span className={styles['icon']}>{severityIcon(n.severity)}</span>
              <div className={styles['body']}>
                <p className={styles['message']}>{n.message}</p>
                <span className={styles['time']}>{relativeTime(n.timestamp)}</span>
                {n.progress !== undefined && !n.progress.done && (
                  <div className={styles['progressRow']}>
                    <div className={styles['progress']}>
                      {n.progress.increment !== undefined ? (
                        <div
                          className={styles['progressBarDeterminate']}
                          style={{ width: `${Math.min(100, Math.max(0, n.progress.increment))}%` }}
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
                      >
                        Cancel
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
              <button
                aria-label="Dismiss"
                className={styles['itemClose']}
                onClick={() => onDismiss(n.id)}
                type="button"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
