import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

interface HoverState {
  x: number
  y: number
}

export interface UseHoverResult {
  hoverProps: Pick<
    HTMLAttributes<HTMLElement>,
    'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'
  >
  isHovering: boolean
  HoverPopup: (props: { children: ReactNode }) => ReactNode
}

/**
 * Returns event handlers and a portal-rendered `HoverPopup` component.
 * The popup appears after `delay` ms of continuous hover/focus.
 */
export function useHover(delay = 500): UseHoverResult {
  const [state, setState] = useState<HoverState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPosRef = useRef<HoverState>({ x: 0, y: 0 })

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleShow = useCallback(() => {
    clear()
    timerRef.current = setTimeout(() => {
      setState({ ...lastPosRef.current })
    }, delay)
  }, [clear, delay])

  const hide = useCallback(() => {
    clear()
    setState(null)
  }, [clear])

  useEffect(() => () => clear(), [clear])

  const hoverProps: UseHoverResult['hoverProps'] = {
    onMouseEnter: (e) => {
      lastPosRef.current = { x: e.clientX + 12, y: e.clientY + 12 }
      scheduleShow()
    },
    onMouseLeave: hide,
    onFocus: (e) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      lastPosRef.current = { x: rect.left, y: rect.bottom + 4 }
      scheduleShow()
    },
    onBlur: hide,
  }

  const HoverPopup = useCallback(
    ({ children }: { children: ReactNode }): ReactNode => {
      if (!state) return null
      return createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: state.y,
            left: state.x,
            zIndex: 10000,
            background: 'var(--workbench-hover-bg, #1e1e1e)',
            border: '1px solid var(--workbench-hover-border, #454545)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 12,
            color: 'var(--workbench-hover-fg, #cccccc)',
            pointerEvents: 'none',
            maxWidth: 320,
          }}
        >
          {children}
        </div>,
        document.body,
      )
    },
    [state],
  )

  return { hoverProps, isHovering: state !== null, HoverPopup }
}
