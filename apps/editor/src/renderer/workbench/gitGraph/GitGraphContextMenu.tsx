/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphContextMenu — the right-click menu for both commit graphs (Git and
 *  Perforce). Items are built from whatever was clicked (commit / branch / remote
 *  / tag / worktree / changelist), so this takes an explicit item list rather
 *  than a MenuId.
 *
 *  A thin adapter over `ListMenu`: keyboard navigation, virtual focus and the
 *  opening highlight all live in the shared menu layer, so the graphs behave
 *  exactly like every other menu in the workbench and the host keeps DOM focus
 *  on its scroll container while the menu is up.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'

export type GitGraphMenuItem =
  | {
      readonly kind: 'item'
      /** Stable identity for the "last executed" memory — the default
       *  label+position fallback shifts the moment the item set changes shape. */
      readonly id: string
      readonly label: string
      readonly icon?: string
      readonly danger?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }

export interface GitGraphMenuState {
  readonly x: number
  readonly y: number
  readonly items: GitGraphMenuItem[]
  /** Raised with the keyboard, so the menu opens with the first entry highlighted. */
  readonly keyboard: boolean
  /** Coarse shape of the clicked target ('commit' | 'stash' | 'branch' | …): the
   *  buckets keep one ref kind's history from restoring into another's menu. */
  readonly contextTag: string
}

export function GitGraphContextMenu({
  state,
  onClose,
}: {
  state: GitGraphMenuState
  onClose: () => void
}) {
  const memory = useContextMenuMemory()
  const items = useMemo<readonly ListMenuEntry[]>(
    () =>
      state.items.map((item) =>
        item.kind === 'sep'
          ? { kind: 'separator' }
          : {
              kind: 'item',
              id: item.id,
              label: item.label,
              icon: item.icon,
              danger: item.danger === true,
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
      {...(memory ? { memory } : {})}
      memoryKey="gitGraph"
      contextTag={state.contextTag}
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
