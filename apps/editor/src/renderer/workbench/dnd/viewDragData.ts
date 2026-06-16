/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  In-memory transfer for view / container drags, mirroring VSCode's
 *  LocalSelectionTransfer. The native DataTransfer can't be read during
 *  `dragover` (browser security), so we keep the payload here for overlay
 *  hit-testing and drop validation, and also stamp a private MIME on the
 *  DataTransfer so other drop zones (Explorer / editor) can tell it apart from a
 *  resource drag and ignore it.
 *--------------------------------------------------------------------------------------------*/

export const VIEW_DRAG_MIME = 'application/vnd.universe-editor.view-drag'

export interface ViewDragPayload {
  /** A single view pane, or a whole container (its tab / activity-bar icon). */
  readonly kind: 'view' | 'container'
  readonly id: string
}

let current: ViewDragPayload | undefined

export const viewDragData = {
  set(payload: ViewDragPayload): void {
    current = payload
  },
  get(): ViewDragPayload | undefined {
    return current
  },
  clear(): void {
    current = undefined
  },
}

/** True when a native drag event carries our private view-drag MIME. */
export function dragContainsView(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes(VIEW_DRAG_MIME)
}
