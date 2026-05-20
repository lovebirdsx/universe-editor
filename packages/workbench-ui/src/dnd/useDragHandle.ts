import { useCallback, useContext, type DragEvent } from 'react'
import { DragSessionContext } from './DragSessionContext.js'

export interface UseDragHandleResult {
  dragHandleProps: {
    draggable: true
    onDragStart: (e: DragEvent) => void
    onDragEnd: (e: DragEvent) => void
  }
}

/**
 * Attach to a draggable element. Stores `payload` in `DragSessionContext`
 * so drop targets on the same React tree can receive it without DataTransfer serialization.
 */
export function useDragHandle<T>(payload: T): UseDragHandleResult {
  const ctx = useContext(DragSessionContext)

  const onDragStart = useCallback(
    (e: DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', '')
      }
      ctx?.setPayload(payload)
    },
    [ctx, payload],
  )

  const onDragEnd = useCallback(
    (_e: DragEvent) => {
      ctx?.clearPayload()
    },
    [ctx],
  )

  return {
    dragHandleProps: {
      draggable: true,
      onDragStart,
      onDragEnd,
    },
  }
}
