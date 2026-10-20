/*---------------------------------------------------------------------------------------------
 *  Pure decision helpers for dragging an editor tab out of every workbench window.
 *
 *  The DOM handlers (EditorGroupView) feed this with the terminal state of the
 *  drag session and the on-screen workbench window rectangles. Keeping the
 *  decision here makes the tricky parts testable without a window manager:
 *  Escape/consumed gestures, zero/NaN coordinates (some platforms report these
 *  on dragend) and drops that landed inside another window must never spawn a
 *  second window.
 *--------------------------------------------------------------------------------------------*/

export interface DragModifiers {
  readonly ctrlKey: boolean
  readonly altKey: boolean
}

/**
 * VSCode's copy-on-drop modifier: Ctrl on Windows/Linux, Option/Alt on macOS.
 */
export function isCopyDragOperation(modifiers: DragModifiers, isMacintosh: boolean): boolean {
  return isMacintosh ? modifiers.altKey : modifiers.ctrlKey
}

export interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type TabDragOutReason =
  | 'disabled'
  | 'consumed'
  | 'cancelled'
  | 'invalid-coordinates'
  | 'inside-window'

export type TabDragOutDecision =
  | { readonly create: false; readonly reason: TabDragOutReason }
  | {
      readonly create: true
      /** Screen point used as the new window's top-left (main clamps it). */
      readonly geometry: { readonly x: number; readonly y: number }
    }

export interface TabDragOutInput {
  readonly enabled: boolean
  readonly consumed: boolean
  readonly cancelled: boolean
  readonly screenX: number
  readonly screenY: number
  /** Every registered workbench window, in screen coordinates. */
  readonly windows: readonly ScreenRect[]
}

function isPointInside(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

export function decideTabDragOut(input: TabDragOutInput): TabDragOutDecision {
  if (!input.enabled) return { create: false, reason: 'disabled' }
  if (input.consumed) return { create: false, reason: 'consumed' }
  if (input.cancelled) return { create: false, reason: 'cancelled' }
  // Chromium on some platforms reports 0,0 (or nothing) for dragend after an
  // aborted gesture. Treat that as "unknown", not as the top-left of the
  // virtual desktop — otherwise a cancelled drag would open a window.
  if (!Number.isFinite(input.screenX) || !Number.isFinite(input.screenY)) {
    return { create: false, reason: 'invalid-coordinates' }
  }
  if (input.screenX === 0 && input.screenY === 0) {
    return { create: false, reason: 'invalid-coordinates' }
  }
  for (const rect of input.windows) {
    if (isPointInside(rect, input.screenX, input.screenY)) {
      return { create: false, reason: 'inside-window' }
    }
  }
  return {
    create: true,
    geometry: { x: Math.round(input.screenX), y: Math.round(input.screenY) },
  }
}
