/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared quick-pick presentation for views.
 *
 *  Both view-switching pickers (Ctrl+Tab's recency list and Ctrl+P) render view
 *  rows identically — same id encoding, label, container description and icon —
 *  so they live here rather than drifting apart in two call sites.
 *--------------------------------------------------------------------------------------------*/

import type {
  IQuickPickItem,
  IViewDescriptor,
  IViewDescriptorService,
} from '@universe-editor/platform'
import { encodeViewPickId } from '../editor/RecentTargetsService.js'

/**
 * `name` and `icon` come from the static descriptor (the runtime layer only
 * remaps container membership, never these); the container is read from the
 * runtime layer so a dragged view shows its current home.
 *
 * Views are never `removable` — there is nothing to close.
 */
export function createViewPickItem(
  descriptor: IViewDescriptor,
  viewDescriptors: IViewDescriptorService,
): IQuickPickItem {
  const container = viewDescriptors.getViewContainerByViewId(descriptor.id)
  const iconId = descriptor.icon ?? container?.icon
  return {
    id: encodeViewPickId(descriptor.id),
    label: descriptor.name,
    removable: false,
    ...(container ? { description: container.label } : {}),
    ...(iconId ? { iconId } : {}),
  }
}
