/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CollapsibleSlot — the shared shell for every Timeline Item (message /
 *  tool-call / plan). A clickable header (leading kind icon + title when
 *  expanded / single-line summary when collapsed + optional status icon +
 *  chevron) toggles the body. Collapse is fully controlled by the parent so a
 *  command can drive it (Alt+F per item, Ctrl+Alt+F cycles all).
 *
 *  `rootProps` are spread onto the root element so callers keep their existing
 *  `data-timeline-key` / `data-role` / `data-kind` / `data-status` / focus class
 *  hooks (selectors and tests depend on these living on the root).
 *--------------------------------------------------------------------------------------------*/

import type { HTMLAttributes, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import styles from './agents.module.css'

export interface CollapsibleSlotProps {
  /** Leading kind icon (lucide element). */
  readonly icon: ReactNode
  /** Header tooltip — the concrete kind label (e.g. 'read' / 'thought' / 'Plan'). */
  readonly kindLabel: string
  /** Title shown when expanded. */
  readonly title?: ReactNode
  /** Single-line summary shown when collapsed; falls back to `title`. */
  readonly summary?: ReactNode
  /** Optional trailing status icon (tool-call status). */
  readonly statusIcon?: ReactNode
  readonly collapsed: boolean
  readonly onToggle: () => void
  /** Collapsible body, rendered only when expanded. */
  readonly children: ReactNode
  /** Spread onto the root element (data-* hooks, focus class, etc.). */
  readonly rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>
  readonly as?: 'li' | 'section'
}

export function CollapsibleSlot({
  icon,
  kindLabel,
  title,
  summary,
  statusIcon,
  collapsed,
  onToggle,
  children,
  rootProps,
  as = 'li',
}: CollapsibleSlotProps) {
  const Tag = as
  const { className: rootClassName, ...restRoot } = rootProps ?? {}
  const cls = rootClassName
    ? `${styles['collapsibleSlot']} ${rootClassName}`
    : styles['collapsibleSlot']
  return (
    <Tag className={cls} {...restRoot}>
      <button
        type="button"
        className={styles['collapsibleHeader']}
        aria-expanded={!collapsed}
        onClick={onToggle}
        title={kindLabel}
        data-testid="acp-collapsible-toggle"
      >
        <span className={styles['slotIcon']} aria-hidden="true">
          {icon}
        </span>
        {collapsed ? (
          <span className={styles['slotSummary']}>{summary ?? title}</span>
        ) : (
          <span className={styles['slotTitle']}>{title}</span>
        )}
        {statusIcon}
        <span className={styles['slotChevron']} aria-hidden="true">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {!collapsed && <div className={styles['slotBody']}>{children}</div>}
    </Tag>
  )
}
