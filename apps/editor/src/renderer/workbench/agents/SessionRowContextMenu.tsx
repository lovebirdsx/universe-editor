/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionRowContextMenu — per-row right-click menu for the AGENTS session list.
 *  Thin wrapper over the workbench-ui ListMenu: the item set depends on the row
 *  (rename is disabled for foreign-worktree rows, "reveal" is disabled when the
 *  session has no transcript file), so it can't come from MenuRegistry — but the
 *  keyboard navigation, virtual focus and opening highlight are the shared ones.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'

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
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
}

export function SessionRowContextMenu({
  state,
  onClose,
}: {
  state: SessionRowContextMenuState
  onClose: () => void
}) {
  const items = useMemo<readonly ListMenuEntry[]>(
    () =>
      state.items.map(
        (item): ListMenuEntry =>
          item.kind === 'separator'
            ? { kind: 'separator' }
            : {
                kind: 'item',
                label: item.label,
                danger: item.danger === true,
                disabled: item.disabled === true,
                run: item.run,
              },
      ),
    [state.items],
  )

  return (
    <ListMenu
      items={items}
      anchor={{ x: state.x, y: state.y }}
      autoFocusFirst={state.keyboard}
      onClose={onClose}
    />
  )
}
