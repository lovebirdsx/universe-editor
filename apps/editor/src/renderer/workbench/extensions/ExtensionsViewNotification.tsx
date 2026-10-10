/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The Extensions view's in-view notification strip (VSCode's
 *  `getExtensionsNotification` bar). Rendered between the search box and the list
 *  as a *sibling* of the flat row list, so it adds no row and cannot disturb
 *  keyboard navigation's index space.
 *--------------------------------------------------------------------------------------------*/

import { X } from 'lucide-react'
import { Severity, localize } from '@universe-editor/platform'
import { Button, IconButton, cx } from '@universe-editor/workbench-ui'
import type { IExtensionsNotification } from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import styles from './ExtensionsView.module.css'

export function ExtensionsViewNotification({
  notification,
  onDismiss,
}: {
  notification: IExtensionsNotification
  onDismiss: () => void
}) {
  const warning = notification.severity !== Severity.Info
  return (
    <div
      className={cx(styles.notification, warning && styles.notificationWarning)}
      data-testid="extensions-notification"
      data-kind={notification.kind}
      role="status"
    >
      <span className={styles.notificationMessage}>{notification.message}</span>
      <div className={styles.notificationActions}>
        {notification.actions.map((action) => (
          <Button
            key={action.label}
            variant={action.isSecondary ? 'secondary' : 'primary'}
            onClick={action.run}
            data-testid={`extensions-notification-${action.label}`}
          >
            {action.label}
          </Button>
        ))}
        <IconButton
          label={localize('extensions.notification.dismiss', 'Dismiss')}
          onClick={onDismiss}
          data-testid="extensions-notification-dismiss"
        >
          <X size={14} />
        </IconButton>
      </div>
    </div>
  )
}
