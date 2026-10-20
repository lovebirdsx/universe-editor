import { useRef, useState, type ReactNode } from 'react'
import { DragSessionContext, type DragSessionState } from './DragSessionContext.js'
import { useDragSessionDocument } from './useDragSessionDocument.js'

/** Wrap any subtree that participates in DnD (ExplorerView, EditorArea, etc.). */
export function DragSessionProvider({ children }: { children: ReactNode }) {
  const payloadRef = useRef<unknown>(undefined)
  const consumedRef = useRef(false)
  const cancelledRef = useRef(false)
  // Force re-render isn't needed for DnD — payload is read synchronously on drop.
  // We expose a stable object so hooks don't re-render on every drag move.
  const [ctx] = useState<DragSessionState>(() => ({
    get payload() {
      return payloadRef.current
    },
    get consumed() {
      return consumedRef.current
    },
    get cancelled() {
      return cancelledRef.current
    },
    begin(p: unknown) {
      payloadRef.current = p
      consumedRef.current = false
      cancelledRef.current = false
    },
    markConsumed() {
      consumedRef.current = true
    },
    markCancelled() {
      cancelledRef.current = true
    },
    clearPayload() {
      payloadRef.current = undefined
    },
  }))

  // Workbench documents other than the main one attach their own cleanup (see
  // useDragSessionDocument). Both `drop` and `dragend` are terminal events of a
  // native drag, so clearing here can never be missed even if the source
  // element unmounted before the browser delivered `dragend` to it. The hook
  // consumes the context, so it must run in a child — the provider itself is
  // outside the value it provides.
  return (
    <DragSessionContext.Provider value={ctx}>
      <MainDocumentDragCleanup />
      {children}
    </DragSessionContext.Provider>
  )
}

function MainDocumentDragCleanup(): null {
  useDragSessionDocument()
  return null
}
