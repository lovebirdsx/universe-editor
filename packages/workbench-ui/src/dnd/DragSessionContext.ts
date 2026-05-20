import { createContext, useContext } from 'react'

interface DragSessionState {
  payload: unknown
  setPayload: (p: unknown) => void
  clearPayload: () => void
}

export const DragSessionContext = createContext<DragSessionState | null>(null)

export function useDragSession(): DragSessionState {
  const ctx = useContext(DragSessionContext)
  if (!ctx) throw new Error('useDragSession must be used inside <DragSessionProvider>')
  return ctx
}
