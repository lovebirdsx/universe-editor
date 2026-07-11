/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineContextMenu — right-click menu for the Outline tree rows.
 *
 *  Like SearchResultsContextMenu / GitGraphContextMenu the items are plain local
 *  callbacks (they act on the tree model / OutlineService rather than global
 *  commands), but this one additionally supports hover-expanded submenus (the
 *  "Go to" group) and disabled items (file-only navigation on a non-code editor).
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import styles from './OutlineContextMenu.module.css'

export type OutlineMenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly disabled?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }
  | {
      readonly kind: 'submenu'
      readonly label: string
      readonly children: readonly OutlineMenuItem[]
    }

export interface OutlineContextMenuState {
  readonly x: number
  readonly y: number
  readonly items: readonly OutlineMenuItem[]
}

export function OutlineContextMenu({
  state,
  onClose,
}: {
  state: OutlineContextMenuState
  onClose: () => void
}) {
  if (state.items.length === 0) return null
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <OutlineMenuList items={state.items} onClose={onClose} />
    </AnchoredSurface>
  )
}

function OutlineMenuList({
  items,
  onClose,
}: {
  items: readonly OutlineMenuItem[]
  onClose: () => void
}) {
  const [openSub, setOpenSub] = useState<{
    key: number
    anchor: { x: number; y: number }
    children: readonly OutlineMenuItem[]
  } | null>(null)

  return (
    <>
      <ul role="menu" className={styles['menu']}>
        {items.map((item, i) => {
          if (item.kind === 'sep') {
            return <li key={`sep-${i}`} role="separator" className={styles['separator']} />
          }
          if (item.kind === 'submenu') {
            return (
              <li
                key={`sub-${i}`}
                role="menuitem"
                className={styles['item']}
                tabIndex={-1}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setOpenSub({
                    key: i,
                    anchor: { x: r.right - 4, y: r.top - 4 },
                    children: item.children,
                  })
                }}
              >
                <span className={styles['label']}>{item.label}</span>
                <ChevronRight
                  size={12}
                  strokeWidth={1.75}
                  className={styles['submenuArrow']}
                  aria-hidden="true"
                />
              </li>
            )
          }
          return (
            <li
              key={`item-${i}`}
              role="menuitem"
              aria-disabled={item.disabled ? true : undefined}
              className={`${styles['item']} ${item.disabled ? styles['disabled'] : ''}`}
              tabIndex={-1}
              onMouseEnter={() => setOpenSub(null)}
              onClick={() => {
                if (item.disabled) return
                onClose()
                item.run()
              }}
            >
              <span className={styles['label']}>{item.label}</span>
            </li>
          )
        })}
      </ul>
      {openSub && (
        <AnchoredSurface x={openSub.anchor.x} y={openSub.anchor.y} placement="right-start">
          <OutlineMenuList items={openSub.children} onClose={onClose} />
        </AnchoredSurface>
      )}
    </>
  )
}
