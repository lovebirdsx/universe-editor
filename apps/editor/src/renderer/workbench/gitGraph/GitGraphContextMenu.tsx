/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphContextMenu — self-contained right-click menu for the Git Graph editor.
 *  Unlike the MenuRegistry-driven ContextMenu, items here are built dynamically
 *  from the object that was clicked (commit / branch / remote / tag), so the menu
 *  takes an explicit item list rather than a MenuId.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import styles from './GitGraphEditor.module.css'

export type GitGraphMenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly danger?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }

export interface GitGraphMenuState {
  readonly x: number
  readonly y: number
  readonly items: GitGraphMenuItem[]
}

export function GitGraphContextMenu({
  state,
  onClose,
}: {
  state: GitGraphMenuState
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <ul ref={ref} role="menu" className={styles['menu']} style={{ top: state.y, left: state.x }}>
      {state.items.map((item, i) =>
        item.kind === 'sep' ? (
          <li key={`sep-${i}`} role="separator" className={styles['menuSep']} />
        ) : (
          <li
            key={`${item.label}-${i}`}
            role="menuitem"
            className={`${styles['menuItem']} ${item.danger ? styles['menuItemDanger'] : ''}`}
            onClick={() => {
              onClose()
              item.run()
            }}
          >
            {item.label}
          </li>
        ),
      )}
    </ul>,
    document.body,
  )
}
