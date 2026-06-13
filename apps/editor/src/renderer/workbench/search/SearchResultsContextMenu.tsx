/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsContextMenu — right-click menu for the search results tree.
 *
 *  Unlike the MenuRegistry-driven ContextMenu, the search actions (copy, dismiss)
 *  operate on the SearchView's local result state rather than global commands, so
 *  this is a small bespoke menu whose items are plain callbacks.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import styles from './SearchResultsContextMenu.module.css'

export interface SearchMenuItem {
  readonly label: string
  readonly run: () => void
}

export interface SearchContextMenuState {
  readonly x: number
  readonly y: number
  readonly items: readonly SearchMenuItem[]
}

export function SearchResultsContextMenu({
  state,
  onClose,
}: {
  state: SearchContextMenuState
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (state.items.length === 0) return null

  return createPortal(
    <ul ref={ref} role="menu" className={styles['menu']} style={{ top: state.y, left: state.x }}>
      {state.items.map((item) => (
        <li
          key={item.label}
          role="menuitem"
          tabIndex={-1}
          className={styles['item']}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>,
    document.body,
  )
}
