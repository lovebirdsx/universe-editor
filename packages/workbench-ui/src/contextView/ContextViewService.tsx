import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import type { ContextViewAnchor, IContextViewService } from './IContextViewService.js'

interface ContextViewState {
  anchor: ContextViewAnchor
  render: () => ReactNode
}

interface ContextViewContextValue {
  service: IContextViewService
}

const ContextViewContext = createContext<ContextViewContextValue | null>(null)

export function useContextViewService(): IContextViewService {
  const ctx = useContext(ContextViewContext)
  if (!ctx) throw new Error('useContextViewService must be used inside <ContextViewProvider>')
  return ctx.service
}

/** Wraps the Workbench root — provides IContextViewService to the subtree. */
export function ContextViewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ContextViewState | null>(null)

  const service: IContextViewService = {
    show: useCallback((anchor: ContextViewAnchor, render: () => ReactNode) => {
      setState({ anchor, render })
    }, []),
    hide: useCallback(() => {
      setState(null)
    }, []),
  }

  return (
    <ContextViewContext.Provider value={{ service }}>
      {children}
      {state && (
        <AnchoredSurface
          x={state.anchor.x}
          y={state.anchor.y}
          onClose={() => setState(null)}
          surfaceProps={{ 'data-context-view': '' } as React.HTMLAttributes<HTMLDivElement>}
        >
          {state.render()}
        </AnchoredSurface>
      )}
    </ContextViewContext.Provider>
  )
}
