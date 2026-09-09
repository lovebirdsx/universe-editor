/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsContextMenu — right-click menu for the search results tree. Thin
 *  wrapper over the workbench-ui ListMenu: the actions (copy, dismiss) operate on
 *  the SearchView's local result state rather than global commands, so the items
 *  are plain callbacks rather than MenuRegistry contributions — but the keyboard
 *  navigation, virtual focus and opening highlight are the shared ones.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'

export interface SearchMenuItem {
  /** Stable identity for the "last executed" memory — the default
   *  label+position fallback shifts the moment the item set changes shape. */
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly run: () => void
}

export interface SearchContextMenuState {
  readonly x: number
  readonly y: number
  readonly items: readonly SearchMenuItem[]
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
}

export function SearchResultsContextMenu({
  state,
  onClose,
}: {
  state: SearchContextMenuState
  onClose: () => void
}) {
  const memory = useContextMenuMemory()
  const items = useMemo<readonly ListMenuEntry[]>(
    () =>
      state.items.map((item) => ({
        kind: 'item',
        id: item.id,
        label: item.label,
        icon: item.icon,
        run: item.run,
      })),
    [state.items],
  )

  return (
    <ListMenu
      items={items}
      anchor={{ x: state.x, y: state.y }}
      autoFocusFirst={state.keyboard}
      {...(memory ? { memory } : {})}
      memoryKey="search.results"
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
