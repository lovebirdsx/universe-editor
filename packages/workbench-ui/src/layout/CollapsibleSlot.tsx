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
 *
 *  An optional `actions` bar sits beside the toggle (never inside it — nested
 *  buttons are invalid) and is revealed on header hover/focus.
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
  /** Optional marker pinned to the row's left edge (e.g. a numbered bookmark),
   *  absolutely positioned so it never shifts the header layout or sticky rects. */
  readonly badge?: ReactNode
  /** Optional trailing action bar (e.g. an "Open Preview" button), rendered
   *  *beside* the toggle — a button cannot nest inside another button. Revealed
   *  on header hover/focus; omit it and the header DOM stays exactly as before. */
  readonly actions?: ReactNode
  readonly collapsed: boolean
  readonly onToggle: () => void
  /** Collapsible body, rendered only when expanded. */
  readonly children: ReactNode
  /** Spread onto the root element (data-* hooks, focus class, etc.). */
  readonly rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>
  /** Extra class for the header button (e.g. sticky positioning inside a
   *  scrolling host — the toggle must stay reachable while the body scrolls). */
  readonly headerClassName?: string | undefined
  readonly as?: 'li' | 'section'
}

export function CollapsibleSlot({
  icon,
  kindLabel,
  title,
  summary,
  statusIcon,
  badge,
  actions,
  collapsed,
  onToggle,
  children,
  rootProps,
  headerClassName,
  as = 'li',
}: CollapsibleSlotProps) {
  const Tag = as
  const { className: rootClassName, ...restRoot } = rootProps ?? {}
  const cls = rootClassName
    ? `${styles['collapsibleSlot']} ${rootClassName}`
    : styles['collapsibleSlot']
  const headerCls = headerClassName
    ? `${styles['collapsibleHeader']} ${headerClassName}`
    : styles['collapsibleHeader']
  const header = (
    <button
      type="button"
      className={headerCls}
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-tooltip={kindLabel}
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
      {/* Reserve room for the hover actions so they can overlay the header's
       *  trailing edge (left of the status icon) without covering the title. */}
      {actions != null && <span className={styles['slotActionsSlot']} aria-hidden="true" />}
      <span className={styles['slotChevron']} aria-hidden="true">
        <Chevron collapsed={collapsed} />
      </span>
    </button>
  )
  return (
    <Tag className={cls} {...restRoot}>
      {badge != null && <span className={styles['slotBadge']}>{badge}</span>}
      {/* Wrap only when there are actions: a caller's `headerClassName` may make
       *  the header `position: sticky`, and an unconditional wrapper the exact
       *  height of the header would clip it out of stickiness immediately. */}
      {actions != null ? (
        <span className={styles['slotHeaderRow']}>
          {header}
          {/* A button cannot nest inside the header's toggle button, so the
           *  actions overlay the header row absolutely, landing just left of the
           *  status icon to line up with the other cards' trailing columns. */}
          <span className={styles['slotActions']}>{actions}</span>
        </span>
      ) : (
        header
      )}
      {!collapsed && <div className={styles['slotBody']}>{children}</div>}
    </Tag>
  )
}
