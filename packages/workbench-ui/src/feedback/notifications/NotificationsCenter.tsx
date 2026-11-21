/*---------------------------------------------------------------------------------------------
 *  NotificationsCenter — presentational notification center panel. Pure: receives
 *  notifications plus dismiss/cancel/clear/close callbacks. Visibility, the
 *  observable subscription and the Portal live in the host wrapper.
 *
 *  The host owns the Vim cursor and passes it in as `focusedIndex` (newest-first,
 *  matching the rendered order); clicking a row reports the new index. The
 *  component only paints the highlight and, when it has DOM focus, forwards
 *  Delete to the focused row so hosts without a Vim mapping still get x-like
 *  dismissal.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { INotification } from '@universe-editor/platform'
import { localize, runWithInvocationModifiers } from '@universe-editor/platform'
import { notificationSeverityClass, notificationSeverityIcon } from './severityIcon.js'
import styles from './NotificationsCenter.module.css'

export interface NotificationsCenterProps {
  readonly notifications: readonly INotification[]
  readonly onDismiss: (id: string) => void
  readonly onCancelProgress: (id: string) => void
  readonly onClearAll: () => void
  readonly onClose: () => void
  /** Highlighted row in rendered (newest-first) order; -1 for none. */
  readonly focusedIndex?: number | undefined
  readonly onFocusChange?: ((index: number) => void) | undefined
  /** Take DOM focus on mount so the overlay Vim surface owns the keyboard. */
  readonly autoFocus?: boolean | undefined
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return localize('notification.time.justNow', 'just now')
  if (diff < 3_600_000) {
    return localize('notification.time.minutesAgo', '{count}m ago', {
      count: String(Math.floor(diff / 60_000)),
    })
  }
  if (diff < 86_400_000) {
    return localize('notification.time.hoursAgo', '{count}h ago', {
      count: String(Math.floor(diff / 3_600_000)),
    })
  }
  return localize('notification.time.daysAgo', '{count}d ago', {
    count: String(Math.floor(diff / 86_400_000)),
  })
}

export function NotificationsCenter({
  notifications,
  onDismiss,
  onCancelProgress,
  onClearAll,
  onClose,
  focusedIndex = -1,
  onFocusChange,
  autoFocus = false,
}: NotificationsCenterProps) {
  // Newest first.
  const items = [...notifications].reverse()
  const activeIndex = items.length === 0 ? -1 : Math.min(focusedIndex, items.length - 1)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus()
  }, [autoFocus])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Functional keys pass the Vim dispatcher's unmapped-printable guard; the
    // row cursor decides which notification this targets. (Vim's `x` needs a
    // keymap entry — see the notification-center WP report.)
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const item = activeIndex < 0 ? undefined : items[activeIndex]
    if (item === undefined) return
    e.preventDefault()
    e.stopPropagation()
    onDismiss(item.id)
  }

  return (
    <div
      ref={rootRef}
      className={styles['overlay']}
      data-testid="notifications-center"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className={styles['header']}>
        <span className={styles['title']}>
          {localize('notification.center.title', 'Notifications')}
        </span>
        {notifications.length > 0 && (
          <button className={styles['clearBtn']} onClick={() => onClearAll()} type="button">
            {localize('notification.center.clearAll', 'Clear All')}
          </button>
        )}
        <button
          aria-label={localize('notification.center.closeAria', 'Close notification center')}
          className={styles['closeBtn']}
          onClick={() => onClose()}
          type="button"
        >
          ×
        </button>
      </div>
      <div className={styles['list']} data-testid="notifications-center-list">
        {items.length === 0 ? (
          <div className={styles['empty']}>
            {localize('notification.center.empty', 'No notifications')}
          </div>
        ) : (
          items.map((n, index) => (
            <div
              key={n.id}
              className={[
                styles['item'],
                n.read ? undefined : styles['unread'],
                index === activeIndex ? styles['itemFocused'] : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid="notification-center-item"
              aria-selected={index === activeIndex}
              onMouseDown={(e) => {
                // Keep DOM focus on the panel: the overlay Vim surface resolves
                // `within`, so losing focus to <body> would drop the keyboard.
                e.preventDefault()
                rootRef.current?.focus()
              }}
              onClick={() => onFocusChange?.(index)}
            >
              <span
                className={`${styles['icon']} ${styles[notificationSeverityClass(n.severity)] ?? ''}`}
              >
                {notificationSeverityIcon(n.severity)}
              </span>
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
                        onClick={(e) => runWithInvocationModifiers(e, () => action.run())}
                        type="button"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                aria-label={localize('common.dismiss', 'Dismiss')}
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
