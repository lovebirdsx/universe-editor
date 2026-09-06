/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteRow — the shared row component for the Remote Explorer tree.
 *  Visuals track the Explorer file row: fixed 22px height, status-dot slot,
 *  ellipsized label, optional muted description, and floating hover actions
 *  overlaid on the right edge. Inner action buttons never trigger the row's
 *  primary action (stopPropagation on the actions slot).
 *
 *  Keyboard handling deliberately lives nowhere here: the row renders inside the
 *  shared `Tree`, whose container owns focus and the arrow / Enter / Space /
 *  ContextMenu keys. Rows are data marked with `data-row-key` + `aria-selected`,
 *  never tab stops — the same model Explorer / Search / SCM use.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties, MouseEvent, ReactNode } from 'react'
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

/** Left padding of a depth-0 row; deeper rows get the tree's indent on top. */
export const REMOTE_ROW_INDENT_BASE = 8
/** Per-depth indent step, preserved from the pre-tree hand-rolled rendering. */
export const REMOTE_ROW_INDENT_WIDTH = 14

/** Collapse toggle state for tree rows (group headers and targets with recents). */
export interface RemoteRowChevronProps {
  readonly expanded: boolean
  readonly onToggle: () => void
}

export interface RemoteRowProps {
  /** Per-row-type test ids kept stable across the split (remote-*-row). */
  readonly testId: string
  /** Tree row identity — drives reveal + keyboard context-menu anchoring. */
  readonly rowKey?: string | undefined
  /** When set, renders the 8px connection-status dot for this state. */
  readonly dot?: RemoteConnectionStateDto | undefined
  readonly label: string
  readonly tooltip: string
  /** Muted suffix after the label (e.g. the WSL "default" badge). */
  readonly description?: string | undefined
  /** Hover-revealed IconButtons, overlaid on the right edge. */
  readonly actions?: ReactNode
  /**
   * Row click. The event is passed through so consumers can honour modifiers
   * (e.g. the recent row's ctrl/cmd = open in new window).
   */
  readonly onClick?: ((e: MouseEvent<HTMLDivElement>) => void) | undefined
  readonly onContextMenu?: ((e: MouseEvent<HTMLDivElement>) => void) | undefined
  /** Whole-row left padding in px (from the tree's depth-derived indent). */
  readonly indentPadding?: number | undefined
  /** When set, renders a leading chevron that toggles without firing onClick. */
  readonly chevron?: RemoteRowChevronProps | undefined
  /** Bold the label (group header rows). */
  readonly emphasized?: boolean
  /** Render `description` as a flexible, ellipsized suffix and keep `label` fully visible. */
  readonly truncateDescription?: boolean
  readonly selected?: boolean
  readonly focused?: boolean
  /** Virtualization positioning style from the tree. */
  readonly style?: CSSProperties | undefined
  /** Row-level ARIA expansion state; omitted for leaves. */
  readonly ariaExpanded?: boolean | undefined
  /** Inert placeholder rows (the empty-state hint) opt out of the pointer affordance. */
  readonly inert?: boolean
}

export function RemoteRow({
  testId,
  rowKey,
  dot,
  label,
  tooltip,
  description,
  actions,
  onClick,
  onContextMenu,
  indentPadding,
  chevron,
  emphasized,
  truncateDescription,
  selected,
  focused,
  style,
  ariaExpanded,
  inert,
}: RemoteRowProps) {
  return (
    <div
      className={cx(
        styles['row'],
        !inert && styles['clickable'],
        selected && styles['selected'],
        focused && styles['focused'],
      )}
      style={{ paddingLeft: indentPadding ?? REMOTE_ROW_INDENT_BASE, ...style }}
      data-testid={testId}
      {...(rowKey !== undefined ? { 'data-row-key': rowKey } : {})}
      role="treeitem"
      {...(ariaExpanded !== undefined ? { 'aria-expanded': ariaExpanded } : {})}
      aria-selected={selected === true}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {chevron && (
        <button
          type="button"
          // Not a tab stop: the tree container owns focus, and Left/Right
          // already expand and collapse the focused row.
          tabIndex={-1}
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
