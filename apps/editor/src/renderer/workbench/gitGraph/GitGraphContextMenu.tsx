/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphContextMenu — self-contained right-click menu for the Git Graph editor.
 *  Unlike the MenuRegistry-driven ContextMenu, items here are built dynamically
 *  from the object that was clicked (commit / branch / remote / tag), so the menu
 *  takes an explicit item list rather than a MenuId.
 *--------------------------------------------------------------------------------------------*/

import { AnchoredSurface } from '@universe-editor/workbench-ui'
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
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
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
      </ul>
    </AnchoredSurface>
  )
}
