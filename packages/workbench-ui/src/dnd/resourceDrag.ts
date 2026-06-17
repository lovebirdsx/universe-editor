import type { DragEvent } from 'react'
import { writeUriList } from './uriList.js'

/** URIs a drag should publish: the whole selection when it has more than one
 *  item and includes the dragged one, otherwise just the dragged resource. */
export function selectionDragUris(self: string, selection?: readonly string[]): string[] {
  if (selection && selection.length > 1 && selection.includes(self)) return [...selection]
  return [self]
}

export interface ResourceDragProps {
  draggable: true
  onDragStart: (e: DragEvent) => void
}

/**
 * Drag props for a row that exports file resources via `text/uri-list` only
 * (no in-tree move payload). A plain function, not a hook, so it can be called
 * inside a `renderRow` loop where hooks are illegal. The drop is received by any
 * `text/uri-list` target (the prompt input, terminal, external apps, the OS).
 */
export function resourceDragProps(getUris: () => readonly string[]): ResourceDragProps {
  return {
    draggable: true,
    onDragStart: (e) => {
      if (!e.dataTransfer) return
      e.dataTransfer.effectAllowed = 'all'
      writeUriList(e.dataTransfer, getUris())
    },
  }
}
