/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmReviewContextMenu — right-click menu for a Swarm review row. Thin wrapper
 *  over the workbench-ui ListMenu: the entries are built per row at open time
 *  (the allowed state transitions arrive from an async Swarm fetch), so they
 *  can't come from MenuRegistry — but the keyboard navigation, virtual focus and
 *  opening highlight are the shared ones.
 *--------------------------------------------------------------------------------------------*/

import { ListMenu, type ListMenuEntry } from '@universe-editor/workbench-ui'
import { renderMenuIcon } from '../icons/menuIcon.js'
import { useContextMenuMemory } from '../contextMenu/useContextMenuMemory.js'

export type SwarmReviewMenuItem = ListMenuEntry

export interface SwarmReviewContextMenuState {
  readonly x: number
  readonly y: number
  readonly reviewId: string
  readonly items: readonly SwarmReviewMenuItem[]
  /** Raised with the ContextMenu key, so it opens with the first entry highlighted. */
  readonly keyboard: boolean
}

export function SwarmReviewContextMenu({
  state,
  onClose,
}: {
  state: SwarmReviewContextMenuState
  onClose: () => void
}) {
  const memory = useContextMenuMemory()

  return (
    <ListMenu
      items={state.items}
      anchor={{ x: state.x, y: state.y }}
      autoFocusFirst={state.keyboard}
      {...(memory ? { memory } : {})}
      memoryKey="swarm.review"
      renderIcon={renderMenuIcon}
      onClose={onClose}
    />
  )
}
