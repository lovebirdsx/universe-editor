import { createContext, useContext } from 'react'

/**
 * State of one native drag gesture.
 *
 * The payload itself is shared between every workbench document (auxiliary
 * windows are portals inside the same React tree). `consumed` / `cancelled`
 * let the drag source distinguish "a drop target handled this" and "the user
 * pressed Escape" from "released outside every window" — the latter is what
 * opens a new editor window.
 */
export interface DragSessionState {
  readonly payload: unknown
  /** A drop target accepted this gesture. Reset on the next dragstart. */
  readonly consumed: boolean
  /** Escape was pressed while dragging. Reset on the next dragstart. */
  readonly cancelled: boolean
  /** Start a gesture (resets consumed/cancelled). */
  begin: (p: unknown) => void
  /** Mark the gesture as handled by a drop target. */
  markConsumed: () => void
  /** Mark the gesture as cancelled (Escape). */
  markCancelled: () => void
  clearPayload: () => void
}

export const DragSessionContext = createContext<DragSessionState | null>(null)

export function useDragSession(): DragSessionState {
  const ctx = useContext(DragSessionContext)
  if (!ctx) throw new Error('useDragSession must be used inside <DragSessionProvider>')
  return ctx
}
