/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Where a focused element sits, for the navigation history: the editor area
 *  or a view. Vim mode records view focus as jump-list entries
 *  (HistoryContribution), and Go Back / Go Forward skips views that can no
 *  longer be focused (historyActions).
 *--------------------------------------------------------------------------------------------*/

import { PartId, type IViewDescriptorService } from '@universe-editor/platform'
import { closestAttr, closestPartId } from '../focus/FocusStackService.js'

export type HistoryLocation =
  | { readonly kind: 'editor' }
  | { readonly kind: 'view'; readonly viewId: string }

const VIEW_PARTS: ReadonlySet<PartId> = new Set([
  PartId.SideBar,
  PartId.Panel,
  PartId.SecondarySideBar,
])

/**
 * Undefined when the element is neither: the activity bar, status bar, title
 * bar, Quick Input and menus are transit points, so callers keep the location
 * they had. A view inside a hidden Part (the Panel's terminal grabbing focus at
 * startup) does not count either.
 */
export function resolveHistoryLocation(
  element: unknown,
  isPartVisible: (partId: PartId) => boolean,
): HistoryLocation | undefined {
  if (!element) return undefined
  const el = element as Element
  const partId = closestPartId(el)
  if (partId === PartId.EditorArea) return { kind: 'editor' }
  if (partId === undefined || !VIEW_PARTS.has(partId) || !isPartVisible(partId)) return undefined
  const viewId = closestAttr(el, 'data-view-id')
  return viewId ? { kind: 'view', viewId } : undefined
}

/** Registered, and not hidden by its `when` clause. */
export function isViewAvailable(views: IViewDescriptorService, viewId: string): boolean {
  const container = views.getViewContainerByViewId(viewId)
  if (!container) return false
  return views.getViewsByContainer(container.id).some((view) => view.id === viewId)
}
