/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteRow — the shared list-row component for every Remote Explorer view.
 *  Visuals track the Explorer file row: fixed 22px height, status-dot slot,
 *  ellipsized label, optional muted description, and floating hover actions
 *  overlaid on the right edge. An explicit onActivate makes the whole row the
 *  primary-action target (click / Enter / Space); inner action buttons never
 *  trigger it (stopPropagation on the actions slot).
 *--------------------------------------------------------------------------------------------*/

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { cx } from '@universe-editor/workbench-ui'
import type { RemoteConnectionStateDto } from '../../../shared/ipc/remoteStatusService.js'
import { dotStateOf } from './remoteRowActions.js'
import styles from './RemoteExplorer.module.css'

const dotStyles = {
  connected: styles['dotConnected'],
  connecting: styles['dotConnecting'],
  failed: styles['dotFailed'],
  idle: styles['dotIdle'],
} as const

export interface RemoteRowProps {
  /** Per-row-type test ids kept stable across the split (remote-*-row). */
  readonly testId: string
  /** When set, renders the 8px connection-status dot for this state. */
  readonly dot?: RemoteConnectionStateDto | undefined
  readonly label: string
  readonly tooltip: string
  /** Muted suffix after the label (e.g. the WSL "default" badge). */
  readonly description?: string | undefined
  /** Hover-revealed IconButtons, overlaid on the right edge. */
  readonly actions?: ReactNode
  /** Primary action: whole-row click + Enter/Space keyboard activation. */
  readonly onActivate?: (() => void) | undefined
  readonly onContextMenu?: ((e: MouseEvent<HTMLDivElement>) => void) | undefined
}

export function RemoteRow({
  testId,
  dot,
  label,
  tooltip,
  description,
  actions,
  onActivate,
  onContextMenu,
}: RemoteRowProps) {
  const activated = onActivate !== undefined
  const handleKeyDown = activated
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }
    : undefined

  return (
    <div
      className={cx(styles['row'], activated && styles['clickable'])}
      data-testid={testId}
      {...(activated ? { role: 'button', tabIndex: 0 } : {})}
      onClick={onActivate}
      onKeyDown={handleKeyDown}
      onContextMenu={onContextMenu}
    >
      {dot !== undefined && (
        <span className={cx(styles['dot'], dotStyles[dotStateOf(dot)])} aria-hidden="true" />
      )}
      <span className={styles['label']} data-tooltip={tooltip}>
        {label}
      </span>
      {description !== undefined && <span className={styles['description']}>{description}</span>}
      {actions !== undefined && (
        <span className={styles['rowActions']} onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  )
}
