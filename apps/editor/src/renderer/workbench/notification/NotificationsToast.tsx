/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Right-bottom toast portal showing unread notifications (max 5 at once).
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService, Severity } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import styles from './NotificationsToast.module.css'

function severityClass(severity: Severity): string {
  if (severity === Severity.Error) return `${styles.toast} ${styles['severity-error']}`
  if (severity === Severity.Warning) return `${styles.toast} ${styles['severity-warning']}`
  return `${styles.toast} ${styles['severity-info']}`
}

function severityIcon(severity: Severity): string {
  if (severity === Severity.Error) return '✕'
  if (severity === Severity.Warning) return '⚠'
  return 'ℹ'
}

export function NotificationsToast() {
  const service = useService(INotificationService)
  const notifications = useObservable(service.notifications)
  const toShow = notifications.filter((n) => !n.read).slice(0, 5)

  if (toShow.length === 0) return null

  return createPortal(
    <div className={styles.container} data-testid="notifications-toast-container">
      {toShow.map((n) => (
        <div key={n.id} className={severityClass(n.severity)} data-testid="notification-toast-item">
          <span className={styles.icon}>{severityIcon(n.severity)}</span>
          <div className={styles.body}>
            <p className={styles.message}>{n.message}</p>
            {n.progress !== undefined && !n.progress.done && (
              <div className={styles.progress}>
                <div className={styles.progressBar} />
              </div>
            )}
            {n.actions !== undefined && n.actions.length > 0 && (
              <div className={styles.actions}>
                {n.actions.map((action) => (
                  <button
                    key={action.label}
                    className={styles.actionBtn}
                    onClick={() => {
                      action.run()
                    }}
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
              aria-label="Dismiss notification"
              className={styles.closeBtn}
              onClick={() => {
                service.dismiss(n.id)
              }}
              type="button"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  )
}
