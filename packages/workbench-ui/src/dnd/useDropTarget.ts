import { useCallback, useContext, type DragEvent } from 'react'
import { DragSessionContext } from './DragSessionContext.js'
import { dragContainsResources } from './uriList.js'

export interface UseDropTargetResult {
  dropTargetProps: {
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

/**
 * Attach to a drop-target element. On drop, calls `onDrop` with the in-tree
 * payload stored by `useDragHandle` (or `undefined` for OS-external / cross-tree
 * drags) plus the raw event, so callers can fall back to reading the
 * DataTransfer (`text/uri-list`, `files`) themselves.
 */
export function useDropTarget<T>(
  onDrop: (payload: T | undefined, e: DragEvent) => void,
): UseDropTargetResult {
  const ctx = useContext(DragSessionContext)

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      // Always preventDefault so external resources can be dropped here too.
      e.preventDefault()
      if (e.dataTransfer) {
        const internal = ctx?.payload !== undefined
        e.dataTransfer.dropEffect = internal
          ? 'move'
          : dragContainsResources(e.dataTransfer)
            ? 'copy'
            : 'none'
      }
    },
    [ctx],
  )

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      onDrop(ctx?.payload as T | undefined, e)
    },
    [ctx, onDrop],
  )

  return {
    dropTargetProps: {
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  }
}
