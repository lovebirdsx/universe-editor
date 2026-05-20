import { useRef, useState, type ReactNode } from 'react'
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

  return <DragSessionContext.Provider value={ctx}>{children}</DragSessionContext.Provider>
}
