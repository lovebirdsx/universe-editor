/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Spatial workbench-window lookup for `workbench.action.navigate*`: which other
 *  window lies in a direction from the focused surface. Window rectangles come
 *  from the native window, so main-window parts are offset to screen coordinates
 *  before both sides are compared through the shared part geometry.
 *--------------------------------------------------------------------------------------------*/

import type { IWorkbenchWindow } from '../windows/workbenchWindowService.js'
import {
  findPartInDirection,
  type NavigateDirection,
  type PartCandidate,
  type PartRect,
} from './partDirection.js'

/** Native window bounds in the same DIP space as `window.screenX/outerWidth`. */
export function windowScreenRect(win: IWorkbenchWindow): PartRect | undefined {
  const { screenX, screenY, outerWidth, outerHeight } = win.window
  if (
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(outerWidth) ||
    !Number.isFinite(outerHeight) ||
    outerWidth <= 0 ||
    outerHeight <= 0
  ) {
    return undefined
  }
  return { left: screenX, top: screenY, right: screenX + outerWidth, bottom: screenY + outerHeight }
}

/** Viewport rect (a part's getBoundingClientRect) to screen coordinates. */
export function offsetRectToScreen(rect: PartRect, win: IWorkbenchWindow): PartRect | undefined {
  const { screenX, screenY } = win.window
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return undefined
  return {
    left: rect.left + screenX,
    top: rect.top + screenY,
    right: rect.right + screenX,
    bottom: rect.bottom + screenY,
  }
}

/** Hidden (minimized) and closed windows cannot receive direction navigation. */
export function isWindowNavigable(win: IWorkbenchWindow): boolean {
  if (win.window.closed === true) return false
  if (win.document.visibilityState === 'hidden') return false
  return windowScreenRect(win) !== undefined
}

export function findWindowInDirection(
  activeWindowId: number,
  origin: PartRect,
  windows: readonly IWorkbenchWindow[],
  direction: NavigateDirection,
): IWorkbenchWindow | undefined {
  const candidates: PartCandidate<IWorkbenchWindow>[] = []
  for (const win of windows) {
    if (win.id === activeWindowId || !isWindowNavigable(win)) continue
    const rect = windowScreenRect(win)
    if (rect !== undefined) candidates.push({ id: win, rect })
  }
  return findPartInDirection(origin, candidates, direction)
}
