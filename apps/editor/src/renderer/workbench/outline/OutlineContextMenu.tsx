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
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
}

function toEntries(items: readonly OutlineMenuItem[]): ListMenuEntry[] {
  return items.map((item): ListMenuEntry => {
    if (item.kind === 'sep') return { kind: 'separator' }
    if (item.kind === 'submenu') {
      return { kind: 'submenu', label: item.label, children: toEntries(item.children) }
    }
    return { kind: 'item', label: item.label, disabled: item.disabled === true, run: item.run }
  })
}

export function OutlineContextMenu({
  state,
  onClose,
}: {
  state: OutlineContextMenuState
  onClose: () => void
}) {
  const items = useMemo(() => toEntries(state.items), [state.items])

  return (
    <ListMenu
      items={items}
      anchor={{ x: state.x, y: state.y }}
      autoFocusFirst={state.keyboard}
      onClose={onClose}
    />
  )
}
