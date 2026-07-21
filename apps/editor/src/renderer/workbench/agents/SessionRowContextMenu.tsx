/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionRowContextMenu — per-row right-click menu for the AGENTS session list.
 *  Hand-built (rather than driven by MenuRegistry) because the item set depends
 *  on the row: rename is disabled for foreign-worktree rows and "reveal" is
 *  disabled when the session has no transcript file. Mirrors the SwarmReviews
 *  context-menu shape.
 *--------------------------------------------------------------------------------------------*/

import { AnchoredSurface } from '@universe-editor/workbench-ui'
import styles from './SessionRowContextMenu.module.css'

export type SessionRowMenuItem =
  | {
      readonly kind: 'item'
      readonly label: string
      readonly danger?: boolean
      readonly disabled?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'separator' }

export interface SessionRowContextMenuState {
  readonly x: number
  readonly y: number
  readonly sessionId: string
  readonly items: readonly SessionRowMenuItem[]
}

export function SessionRowContextMenu({
  state,
  onClose,
}: {
  state: SessionRowContextMenuState
  onClose: () => void
}) {
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
        {state.items.map((item, index) =>
          item.kind === 'separator' ? (
            <li key={`separator-${index}`} role="separator" className={styles['separator']} />
          ) : (
            <li
              key={`${item.label}-${index}`}
              role="menuitem"
              aria-disabled={item.disabled ? 'true' : undefined}
              tabIndex={-1}
              className={`${styles['item']} ${item.danger ? styles['danger'] : ''} ${
                item.disabled ? styles['disabled'] : ''
              }`}
              onClick={() => {
                if (item.disabled) return
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
