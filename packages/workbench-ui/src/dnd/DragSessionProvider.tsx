import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DragSessionContext } from './DragSessionContext.js'

/** Wrap any subtree that participates in DnD (ExplorerView, EditorArea, etc.). */
export function DragSessionProvider({ children }: { children: ReactNode }) {
  const payloadRef = useRef<unknown>(undefined)
  // Force re-render isn't needed for DnD — payload is read synchronously on drop.
  // We expose a stable object so hooks don't re-render on every drag move.
  const [ctx] = useState(() => ({
    get payload() {
      return payloadRef.current
    },
    setPayload(p: unknown) {
      payloadRef.current = p
    },
    clearPayload() {
      payloadRef.current = undefined
    },
  }))

  // Safety net: `useDragHandle`'s onDragEnd clears the payload, but the drag
  // source can be unmounted before the browser dispatches `dragend` to it — e.g.
  // dropping an editor tab into a split moves (remounts) the source tab, so its
  // dragend never fires and the payload lingers. A stale payload then makes the
  // next unrelated drop (a file from the Explorer) look like an in-tree tab move,
  // silently no-op-ing the open. Every gesture ends with a window-level `drop` or
  // `dragend`, so clear there too — it can never be missed.
  useEffect(() => {
    const clear = (): void => {
      payloadRef.current = undefined
    }
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [])

  return <DragSessionContext.Provider value={ctx}>{children}</DragSessionContext.Provider>
}
