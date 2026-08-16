/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteRow — the shared list-row component for the Remote Explorer tree.
 *  Visuals track the Explorer file row: fixed 22px height, status-dot slot,
 *  ellipsized label, optional muted description, and floating hover actions
 *  overlaid on the right edge. An explicit onActivate makes the whole row the
 *  primary-action target (click / Enter / Space); inner action buttons never
 *  trigger it (stopPropagation on the actions slot). Optional `indent` /
 *  `chevron` turn it into a tree row (group headers + targets with recents).
 *--------------------------------------------------------------------------------------------*/

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
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

/** Collapse toggle state for tree rows (group headers and targets with recents). */
export interface RemoteRowChevronProps {
  readonly expanded: boolean
  readonly onToggle: () => void
}

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
  /** Left indentation depth in levels (group = 0, target = 1, recent = 2). */
  readonly indent?: number
  /** When set, renders a leading chevron that toggles without firing onActivate. */
  readonly chevron?: RemoteRowChevronProps | undefined
  /** Bold the label (group header rows). */
  readonly emphasized?: boolean
  /** Render `description` as a flexible, ellipsized suffix and keep `label` fully visible. */
  readonly truncateDescription?: boolean
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
  indent,
  chevron,
  emphasized,
  truncateDescription,
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

  const indentPx = 8 + (indent ?? 0) * 14

  return (
    <div
      className={cx(styles['row'], activated && styles['clickable'])}
      style={{ paddingLeft: indentPx }}
      data-testid={testId}
      {...(activated ? { role: 'button', tabIndex: 0 } : {})}
      onClick={onActivate}
      onKeyDown={handleKeyDown}
      onContextMenu={onContextMenu}
    >
      {chevron && (
        <button
          type="button"
          className={cx(styles['chevron'], !chevron.expanded && styles['chevronCollapsed'])}
          onClick={(e) => {
            e.stopPropagation()
            chevron.onToggle()
          }}
          aria-expanded={chevron.expanded}
          aria-label={chevron.expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {dot !== undefined && (
        <span className={cx(styles['dot'], dotStyles[dotStateOf(dot)])} aria-hidden="true" />
      )}
      <span
        className={cx(
          styles['label'],
          emphasized && styles['labelEmphasized'],
          truncateDescription && styles['labelFixed'],
        )}
        data-tooltip={tooltip}
      >
        {label}
      </span>
      {description !== undefined && (
        <span
          className={cx(
            styles['description'],
            truncateDescription && styles['descriptionTruncatable'],
          )}
        >
          {description}
        </span>
      )}
      {actions !== undefined && (
        <span className={styles['rowActions']} onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  )
}
