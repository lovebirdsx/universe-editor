import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
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
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Lazy-create a portal container in document.body.
  if (!containerRef.current && typeof document !== 'undefined') {
    const el = document.createElement('div')
    el.setAttribute('data-context-view', '')
    document.body.appendChild(el)
    containerRef.current = el
  }

  // Close on click-outside.
  useEffect(() => {
    if (!state) return
    const onMousedown = (e: MouseEvent) => {
      const container = containerRef.current
      if (container && !container.contains(e.target as Node)) {
        setState(null)
      }
    }
    document.addEventListener('mousedown', onMousedown)
    return () => document.removeEventListener('mousedown', onMousedown)
  }, [state])

  // Close on Escape.
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state])

  // Cleanup portal element on unmount.
  useEffect(() => {
    const el = containerRef.current
    return () => {
      if (el?.parentNode) el.parentNode.removeChild(el)
    }
  }, [])

  const service: IContextViewService = {
    show: useCallback((anchor: ContextViewAnchor, render: () => ReactNode) => {
      setState({ anchor, render })
    }, []),
    hide: useCallback(() => {
      setState(null)
    }, []),
  }

  const portal =
    state && containerRef.current
      ? createPortal(
          <div
            style={{
              position: 'fixed',
              top: state.anchor.y,
              left: state.anchor.x,
              zIndex: 9999,
            }}
          >
            {state.render()}
          </div>,
          containerRef.current,
        )
      : null

  return (
    <ContextViewContext.Provider value={{ service }}>
      {children}
      {portal}
    </ContextViewContext.Provider>
  )
}
