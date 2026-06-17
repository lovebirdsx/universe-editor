/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single drop resolver shared by every view drop zone (ActivityBar items + its
 *  empty area, PaneComposite tabs + their empty area, ViewPaneContainer). Maps a
 *  drag payload (a whole container, or a single view) and a drop target (an
 *  existing container, or a bare location) onto the right IViewDescriptorService
 *  mutation, mirroring VSCode's unified drag semantics. A container dropped onto
 *  another container's centre (`merge`) folds all its views into the target;
 *  dropped onto an edge it reorders / relocates instead.
 *--------------------------------------------------------------------------------------------*/

import type { IViewDescriptorService, ViewContainerLocation } from '@universe-editor/platform'
import type { ViewDragPayload } from './viewDragData.js'

export type ViewDropTarget =
  | { readonly kind: 'container'; readonly containerId: string; readonly merge?: boolean }
  | { readonly kind: 'location'; readonly location: ViewContainerLocation }

export function applyViewDrop(
  viewDescriptors: IViewDescriptorService,
  payload: ViewDragPayload,
  target: ViewDropTarget,
): void {
  if (payload.kind === 'container') {
    if (target.kind === 'container') {
      if (payload.id === target.containerId) return
      if (target.merge) {
        const viewIds = viewDescriptors.getViewsByContainer(payload.id).map((v) => v.id)
        if (viewIds.length > 0) viewDescriptors.moveViewsToContainer(viewIds, target.containerId)
        return
      }
      const from = viewDescriptors.getViewContainerLocation(payload.id)
      const to = viewDescriptors.getViewContainerLocation(target.containerId)
      if (from !== undefined && to !== undefined && from === to) {
        viewDescriptors.moveContainerInLocation(payload.id, target.containerId)
      } else if (to !== undefined) {
        viewDescriptors.moveViewContainerToLocation(payload.id, to)
      }
    } else {
      viewDescriptors.moveViewContainerToLocation(payload.id, target.location)
    }
    return
  }

  if (target.kind === 'container') {
    viewDescriptors.moveViewsToContainer([payload.id], target.containerId)
  } else {
    viewDescriptors.moveViewToLocation(payload.id, target.location)
  }
}
