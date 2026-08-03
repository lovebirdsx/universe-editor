import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import styles from '../tooltip/tooltipSurface.module.css'

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
 * The popup appears after `delay` ms of continuous hover/focus. Positioning goes
 * through AnchoredSurface so the tooltip flips/shifts instead of spilling off-screen.
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
      return (
        <AnchoredSurface
          x={state.x}
          y={state.y}
          surfaceProps={{
            role: 'tooltip',
            className: styles['tooltipSurface'],
          }}
        >
          {children}
        </AnchoredSurface>
      )
    },
    [state],
  )

  return { hoverProps, isHovering: state !== null, HoverPopup }
}
