/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Notification center panel — portal shown when centerVisible is true.
 *--------------------------------------------------------------------------------------------*/

import { createPortal } from 'react-dom'
import { INotificationService, Severity } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import styles from './NotificationsCenter.module.css'

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

export function NotificationsCenter() {
  const service = useService(INotificationService)
  const visible = useObservable(service.centerVisible)
  const notifications = useObservable(service.notifications)

  if (!visible) return null

  // Newest first.
  const items = [...notifications].reverse()

  return createPortal(
    <div className={styles.overlay} data-testid="notifications-center">
      <div className={styles.header}>
        <span className={styles.title}>Notifications</span>
        {notifications.length > 0 && (
          <button
            className={styles.clearBtn}
            onClick={() => {
              service.clearAll()
            }}
            type="button"
          >
            Clear All
          </button>
        )}
        <button
          aria-label="Close notification center"
          className={styles.closeBtn}
          onClick={() => {
            service.toggleCenter()
          }}
          type="button"
        >
          ×
        </button>
      </div>
      <div className={styles.list}>
        {items.length === 0 ? (
          <div className={styles.empty}>No notifications</div>
        ) : (
          items.map((n) => (
            <div
              key={n.id}
              className={n.read ? styles.item : `${styles.item} ${styles.unread}`}
              data-testid="notification-center-item"
            >
              <span className={styles.icon}>{severityIcon(n.severity)}</span>
              <div className={styles.body}>
                <p className={styles.message}>{n.message}</p>
                <span className={styles.time}>{relativeTime(n.timestamp)}</span>
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
              <button
                aria-label="Dismiss"
                className={styles.itemClose}
                onClick={() => {
                  service.dismiss(n.id)
                }}
                type="button"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  )
}
