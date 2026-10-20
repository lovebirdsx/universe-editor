import { useCallback, useContext, type DragEvent } from 'react'
import { DragSessionContext } from './DragSessionContext.js'
import { writeUriList } from './uriList.js'
import { isResizeEdgeDrag } from './resizeEdgeGuard.js'

/** Read-only snapshot handed to `onDragEnd` before the session is cleared. */
export interface DragEndSnapshot {
  readonly payload: unknown
  readonly consumed: boolean
  readonly cancelled: boolean
}

export interface UseDragHandleOptions {
  /**
   * Lazily-evaluated list of resource URIs to publish on `text/uri-list` so the
   * drag can be received by other panels, external apps, and the OS. Evaluated
   * at dragstart to capture the latest selection.
   */
  readonly uriList?: () => readonly string[]
  /**
   * Called from `dragend` before the shared payload is cleared. The snapshot
   * carries the terminal flags so a tab can decide whether releasing outside
   * every window should create a new one (see `decideTabDragOut`).
   */
  readonly onDragEnd?: (e: DragEvent, snapshot: DragEndSnapshot) => void
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
  const onEnd = options?.onDragEnd

  const onDragStart = useCallback(
    (e: DragEvent) => {
      // A press on the row's left/right edge is a resize-sash gesture, not a
      // content drag — cancel so the sash underneath (Explorer row width fills
      // the pane, overlapping the sidebar resize seam) receives it.
      if (isResizeEdgeDrag(e.currentTarget, e.clientX)) {
        e.preventDefault()
        return
      }
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'all'
        e.dataTransfer.setData('text/plain', '')
        if (getUriList) {
          const uris = getUriList()
          if (uris.length > 0) writeUriList(e.dataTransfer, uris)
        }
      }
      ctx?.begin(payload)
    },
    [ctx, payload, getUriList],
  )

  const onDragEnd = useCallback(
    (e: DragEvent) => {
      // Capture the terminal state before clearing: drag-out detection needs
      // to know whether a drop target consumed the gesture or Escape cancelled
      // it, and the payload itself.
      if (ctx) {
        onEnd?.(e, {
          payload: ctx.payload,
          consumed: ctx.consumed,
          cancelled: ctx.cancelled,
        })
        ctx.clearPayload()
      } else {
        onEnd?.(e, { payload: undefined, consumed: false, cancelled: false })
      }
    },
    [ctx, onEnd],
  )

  return {
    dragHandleProps: {
      draggable: true,
      onDragStart,
      onDragEnd,
    },
  }
}
