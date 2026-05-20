import { useCallback, useContext, type DragEvent } from 'react'
import { DragSessionContext } from './DragSessionContext.js'

export interface UseDropTargetResult {
  dropTargetProps: {
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

/**
 * Attach to a drop-target element. When a drop occurs, calls `onDrop` with
 * the payload stored by `useDragHandle`.
 */
export function useDropTarget<T>(onDrop: (payload: T) => void): UseDropTargetResult {
  const ctx = useContext(DragSessionContext)

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      if (ctx?.payload !== undefined) {
        onDrop(ctx.payload as T)
      }
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
