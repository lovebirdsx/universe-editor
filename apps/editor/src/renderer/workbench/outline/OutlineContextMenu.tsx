/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineContextMenu — right-click menu for the Outline tree rows. Thin wrapper
 *  over the workbench-ui ListMenu: the items are plain local callbacks (they act
 *  on the tree model / OutlineService rather than global commands), so they can't
 *  come from MenuRegistry — but the keyboard navigation, the "Go to" submenu and
 *  the opening highlight are the shared ones.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'

export type OutlineMenuItem =
  | {
      readonly kind: 'item'
      /** Stable identity for the "last executed" memory — the default
       *  label+position fallback shifts the moment the item set changes shape. */
      readonly id: string
      readonly label: string
      readonly icon?: string
      readonly disabled?: boolean
      readonly run: () => void
    }
  | { readonly kind: 'sep' }
  | {
      readonly kind: 'submenu'
      readonly id: string
      readonly label: string
      readonly icon?: string
      readonly children: readonly OutlineMenuItem[]
    }

export interface OutlineContextMenuState {
  readonly x: number
  readonly y: number
  readonly items: readonly OutlineMenuItem[]
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
}

function toEntries(items: readonly OutlineMenuItem[]): ListMenuEntry[] {
  return items.map((item): ListMenuEntry => {
    if (item.kind === 'sep') return { kind: 'separator' }
    if (item.kind === 'submenu') {
      return {
        kind: 'submenu',
        id: item.id,
        label: item.label,
        icon: item.icon,
        children: toEntries(item.children),
      }
    }
    return {
      kind: 'item',
      id: item.id,
      label: item.label,
      icon: item.icon,
      disabled: item.disabled === true,
      run: item.run,
    }
  })
}

export function OutlineContextMenu({
  state,
  onClose,
}: {
  state: OutlineContextMenuState
  onClose: () => void
}) {
  const memory = useContextMenuMemory()
  const items = useMemo(() => toEntries(state.items), [state.items])

  return (
    <ListMenu
      items={items}
      anchor={{ x: state.x, y: state.y }}
      autoFocusFirst={state.keyboard}
      {...(memory ? { memory } : {})}
      memoryKey="outline"
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
