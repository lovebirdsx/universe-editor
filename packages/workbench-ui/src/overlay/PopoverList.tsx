/*---------------------------------------------------------------------------------------------
 *  PopoverList — keyboard-navigable suggestion list shown above/below an input
 *  (slash commands, @-mentions, etc.). Pure presentation: navigation and
 *  acceptance are driven by the owning input through `activeIndex`, so focus
 *  never leaves the textarea. `onSelect` fires on mousedown (focus-preserving).
 *
 *  Positioning is the caller's concern — pass `className` with the anchor inset.
 *  Row content is the caller's concern — supply it via `renderItem`.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type ReactNode } from 'react'
import { cx } from '../atoms/cx.js'
import styles from './PopoverList.module.css'

export interface PopoverListProps<T> {
  readonly items: readonly T[]
  readonly activeIndex: number
  readonly getKey: (item: T, index: number) => string
  readonly renderItem: (item: T, state: { active: boolean }) => ReactNode
  readonly onSelect: (item: T, index: number) => void
  readonly onHover: (index: number) => void
  /** Shown when the list is empty (and not loading). */
  readonly emptyLabel?: ReactNode
  /** When true and the list is empty, shows `loadingLabel` instead of `emptyLabel`. */
  readonly loading?: boolean
  readonly loadingLabel?: ReactNode
  /** Caller-supplied positioning/anchor class merged onto the root. */
  readonly className?: string | undefined
  /** Extra class merged onto every row. */
  readonly itemClassName?: string | undefined
  readonly 'data-testid'?: string
  readonly 'aria-label'?: string
}

export function PopoverList<T>({
  items,
  activeIndex,
  getKey,
  renderItem,
  onSelect,
  onHover,
  emptyLabel,
  loading = false,
  loadingLabel,
  className,
  itemClassName,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: PopoverListProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the active row in view when the user navigates with arrow keys.
  useEffect(() => {
    const root = listRef.current
    if (!root) return
    const el = root.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (items.length === 0) {
    const label = loading ? (loadingLabel ?? emptyLabel) : emptyLabel
    return (
      <div
        className={cx(styles['popover'], className)}
        role="listbox"
        data-testid={testId}
        aria-label={ariaLabel}
      >
        {label != null && <div className={styles['empty']}>{label}</div>}
      </div>
    )
  }

  return (
    <div
      className={cx(styles['popover'], className)}
      role="listbox"
      ref={listRef}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {items.map((item, i) => {
        const active = i === activeIndex
        return (
          <div
            key={getKey(item, i)}
            role="option"
            aria-selected={active}
            data-active={active}
            className={cx(styles['item'], itemClassName)}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before our click lands.
              e.preventDefault()
              onSelect(item, i)
            }}
            // onMouseMove (not onMouseEnter): the popover often pops up directly
            // under a stationary cursor, and the browser fires a synthetic
            // mouseenter for whatever row lands under it — which would hijack the
            // keyboard selection to the cursor's position the moment arrow keys
            // are used. A genuine cursor move fires mousemove; a layout change
            // beneath a still cursor does not. So hover only steals selection on
            // real pointer movement.
            onMouseMove={() => onHover(i)}
          >
            {renderItem(item, { active })}
          </div>
        )
      })}
    </div>
  )
}
