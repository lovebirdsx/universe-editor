/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsContextMenu — right-click menu for the search results tree.
 *
 *  Unlike the MenuRegistry-driven ContextMenu, the search actions (copy, dismiss)
 *  operate on the SearchView's local result state rather than global commands, so
 *  this is a small bespoke menu whose items are plain callbacks.
 *--------------------------------------------------------------------------------------------*/

import { AnchoredSurface } from '@universe-editor/workbench-ui'
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
  if (state.items.length === 0) return null

  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
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
      </ul>
    </AnchoredSurface>
  )
}
