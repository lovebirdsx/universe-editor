/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MenuRows — one menu level plus, when a submenu row is expanded, the panel for
 *  the level below it. Shared by the root menu and every submenu panel so a
 *  nested level behaves exactly like the top one, to any depth, and shared by
 *  both menu flavours (`ContextMenu`, `ListMenu`) so their DOM stays identical.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef, type ReactNode } from 'react'
import {
  computeSubmenuPosition,
  type IViewportSize,
  type SubmenuDirection,
} from '../overlay/anchorLayout.js'
import { useTransformFreePlacement } from '../overlay/useTransformFreePlacement.js'
import type { RowModel } from './menuModel.js'
import type { MenuState } from './useMenuNavigation.js'
import styles from './ContextMenu.module.css'

export interface MenuRowsProps {
  readonly uid: string
  readonly rows: readonly RowModel[]
  readonly level: number
  readonly state: MenuState
  readonly direction: SubmenuDirection
  readonly onRowEnter: (level: number, index: number, isSubmenu: boolean) => void
  readonly onCancelClose: () => void
  readonly renderIcon?: ((icon: string | undefined) => ReactNode) | undefined
  readonly className?: string | undefined
  readonly style?: React.CSSProperties | undefined
  readonly innerRef?: React.Ref<HTMLUListElement> | undefined
  readonly testId?: string | undefined
}

const rowElementId = (uid: string, level: number, index: number): string =>
  `${uid}-${level}-${index}`

export function MenuRows({
  uid,
  rows,
  level,
  state,
  direction,
  onRowEnter,
  onCancelClose,
  renderIcon,
  className,
  style,
  innerRef,
  testId,
}: MenuRowsProps) {
  const openIndex = state.open[level]
  const active = state.active?.level === level ? state.active.index : undefined
  const openRow = openIndex === undefined ? undefined : rows[openIndex]
  const activeId = active === undefined ? undefined : rowElementId(uid, level, active)

  return (
    <>
      <ul
        ref={innerRef}
        role="menu"
        aria-activedescendant={activeId}
        className={className === undefined ? styles['menu'] : `${styles['menu']} ${className}`}
        {...(style ? { style } : {})}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        onMouseEnter={onCancelClose}
      >
        {rows.map((row, index) => {
          const id = rowElementId(uid, level, index)
          if (row.kind === 'separator') {
            return <li key={row.id} role="separator" className={styles['separator']} />
          }
          const isActive = index === active || index === openIndex
          const disabled = row.kind === 'item' && row.disabled === true
          const common = {
            id,
            role: 'menuitem' as const,
            tabIndex: -1,
            ...(isActive ? { 'data-active': '' } : {}),
            ...(disabled ? { 'aria-disabled': true } : {}),
            // A disabled row still cancels a pending submenu close (the pointer
            // is demonstrably inside this panel) but never takes the highlight.
            onMouseEnter: () =>
              disabled ? onCancelClose() : onRowEnter(level, index, row.kind === 'submenu'),
          }
          // The slot is rendered for every row once `renderIcon` is set, even
          // when that row has no icon, so labels line up in a mixed menu.
          const iconSlot = renderIcon ? (
            <span className={styles['icon']} aria-hidden="true">
              {renderIcon(row.icon)}
            </span>
          ) : null
          if (row.kind === 'submenu') {
            return (
              <li
                key={row.id}
                {...common}
                aria-haspopup="menu"
                aria-expanded={index === openIndex}
                className={`${styles['item']} ${styles['submenuItem']}`}
              >
                {iconSlot}
                <span className={styles['label']}>{row.label}</span>
              </li>
            )
          }
          const itemClass = [
            styles['item'],
            row.danger === true ? styles['danger'] : undefined,
            disabled ? styles['disabled'] : undefined,
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <li
              key={row.id}
              {...common}
              className={itemClass}
              onClick={disabled ? undefined : row.run}
            >
              {iconSlot}
              <span className={styles['label']}>{row.label}</span>
              {row.hint !== undefined && <span className={styles['hint']}>{row.hint}</span>}
            </li>
          )
        })}
      </ul>
      {/*
        The panel is a sibling of `.menu` (which scrolls, and would clip an
        absolutely positioned child) but still inside the anchored surface's
        floating element: Floating UI's dismiss-on-outside-press only ignores
        presses within that element, so a panel portalled elsewhere would close
        the whole menu on mousedown and swallow the click.
      */}
      {openRow?.kind === 'submenu' && openIndex !== undefined && (
        <SubmenuPanel
          key={openRow.id}
          uid={uid}
          rows={openRow.children}
          level={level + 1}
          state={state}
          direction={direction}
          parentRowId={rowElementId(uid, level, openIndex)}
          onRowEnter={onRowEnter}
          onCancelClose={onCancelClose}
          renderIcon={renderIcon}
        />
      )}
    </>
  )
}

interface SubmenuPanelProps extends Omit<
  MenuRowsProps,
  'className' | 'style' | 'innerRef' | 'testId'
> {
  readonly parentRowId: string
}

function SubmenuPanel({ parentRowId, direction, ...rest }: SubmenuPanelProps) {
  const ref = useRef<HTMLUListElement>(null)

  const compute = useCallback(
    (panel: IViewportSize, viewport: IViewportSize) => {
      const el = ref.current
      // Line the panel's first row up with the parent row rather than with the
      // parent menu's padding edge.
      const padding = parseFloat(
        el?.ownerDocument.defaultView?.getComputedStyle(el).paddingTop ?? '',
      )
      const paddingTop = Number.isFinite(padding) ? padding : 0
      const parent = el?.ownerDocument.getElementById(parentRowId)?.getBoundingClientRect()
      return computeSubmenuPosition(
        viewport,
        panel,
        {
          top: (parent?.top ?? 0) - paddingTop,
          left: parent?.left ?? 0,
          width: parent?.width ?? 0,
          height: (parent?.height ?? 0) + 2 * paddingTop,
        },
        direction,
      )
    },
    [parentRowId, direction],
  )

  const { placement, style } = useTransformFreePlacement(ref, compute)

  return (
    <MenuRows
      {...rest}
      direction={placement?.direction ?? direction}
      innerRef={ref}
      className={styles['submenu']}
      testId="context-menu-submenu"
      style={style}
    />
  )
}
