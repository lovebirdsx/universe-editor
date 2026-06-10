import { useCallback, useContext, type DragEvent } from 'react'
import { DragSessionContext } from './DragSessionContext.js'
import { writeUriList } from './uriList.js'

export interface UseDragHandleOptions {
  /**
   * Lazily-evaluated list of resource URIs to publish on `text/uri-list` so the
   * drag can be received by other panels, external apps, and the OS. Evaluated
   * at dragstart to capture the latest selection.
   */
  readonly uriList?: () => readonly string[]
}

export interface UseDragHandleResult {
  dragHandleProps: {
    draggable: true
    onDragStart: (e: DragEvent) => void
    onDragEnd: (e: DragEvent) => void
  }
}

/**
 * Attach to a draggable element. Stores `payload` in `DragSessionContext`
 * so drop targets on the same React tree can receive it without DataTransfer
 * serialization. When `options.uriList` is given, also writes the standard
 * `text/uri-list` payload so cross-boundary targets can read it.
 */
export function useDragHandle<T>(payload: T, options?: UseDragHandleOptions): UseDragHandleResult {
  const ctx = useContext(DragSessionContext)
  const getUriList = options?.uriList

  const onDragStart = useCallback(
    (e: DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'all'
        e.dataTransfer.setData('text/plain', '')
        if (getUriList) {
          const uris = getUriList()
          if (uris.length > 0) writeUriList(e.dataTransfer, uris)
        }
      }
      ctx?.setPayload(payload)
    },
    [ctx, payload, getUriList],
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
