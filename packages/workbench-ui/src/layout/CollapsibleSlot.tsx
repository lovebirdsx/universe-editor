/*---------------------------------------------------------------------------------------------
 *  CollapsibleSlot — the shared shell for a collapsible row (e.g. a Timeline Item:
 *  message / tool-call / plan). A clickable header (leading kind icon + title when
 *  expanded / single-line summary when collapsed + optional status icon +
 *  chevron) toggles the body. Collapse is fully controlled by the parent so a
 *  command can drive it.
 *
 *  `rootProps` are spread onto the root element so callers keep their existing
 *  `data-*` / focus class hooks (selectors and tests depend on these living on
 *  the root). The chevron is rendered inline (no icon-library dependency).
 *--------------------------------------------------------------------------------------------*/

import type { HTMLAttributes, ReactNode } from 'react'
import styles from './CollapsibleSlot.module.css'

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {collapsed ? <path d="m9 18 6-6-6-6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  )
}

export interface CollapsibleSlotProps {
  /** Leading kind icon (any element). */
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
          <Chevron collapsed={collapsed} />
        </span>
      </button>
      {!collapsed && <div className={styles['slotBody']}>{children}</div>}
    </Tag>
  )
}
