import { useEffect, useRef, useState, type ReactNode } from 'react'
import { strings } from '../strings.js'

const ACTION_WIDTH_PX = 76
const TOTAL_ACTION_WIDTH_PX = ACTION_WIDTH_PX * 2
const LONG_PRESS_MS = 500
const SWIPE_START_PX = 10

export interface SwipeableSessionRowProps {
  readonly children: ReactNode
  readonly open: boolean
  readonly disabled: boolean
  readonly onGestureStart: () => void
  readonly onOpenChange: (open: boolean) => void
  readonly onShowActions: () => void
  readonly onCloseSession: () => void
  readonly onRemoveSession: () => void
}

interface DragState {
  readonly startX: number
  readonly startY: number
  readonly base: number
  moved: boolean
}

/**
 * iOS-style row: swipe left to reveal close/remove, long-press for the same
 * actions. Pointer events are only captured once the gesture is clearly
 * horizontal, so vertical scrolling still belongs to the browser.
 */
export function SwipeableSessionRow({
  children,
  open,
  disabled,
  onGestureStart,
  onOpenChange,
  onShowActions,
  onCloseSession,
  onRemoveSession,
}: SwipeableSessionRowProps) {
  const [dragOffset, setDragOffset] = useState<number | undefined>(undefined)
  const drag = useRef<DragState | undefined>(undefined)
  const offset = useRef(0)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressClick = useRef(false)

  useEffect(
    () => () => {
      if (longPressTimer.current !== undefined) clearTimeout(longPressTimer.current)
    },
    [],
  )

  const clearLongPress = (): void => {
    if (longPressTimer.current === undefined) return
    clearTimeout(longPressTimer.current)
    longPressTimer.current = undefined
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return
    onGestureStart()
    // A pointerup can land off-track (mouse long-press opens the sheet), so the
    // next gesture must clear the stale click suppression itself. Clearing the
    // timer also stops a second finger from leaving the first long-press armed.
    clearLongPress()
    suppressClick.current = false
    const base = open ? -TOTAL_ACTION_WIDTH_PX : 0
    drag.current = { startX: event.clientX, startY: event.clientY, base, moved: false }
    offset.current = base
    if (!open) {
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = undefined
        if (drag.current?.moved === true) return
        suppressClick.current = true
        onShowActions()
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === undefined) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.moved) {
      if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) >= Math.abs(dx)) {
        clearLongPress()
        return
      }
      if (Math.abs(dx) <= SWIPE_START_PX || Math.abs(dx) <= Math.abs(dy)) return
      current.moved = true
      clearLongPress()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    suppressClick.current = true
    offset.current = Math.max(-TOTAL_ACTION_WIDTH_PX, Math.min(0, current.base + dx))
    setDragOffset(offset.current)
    if (event.cancelable) event.preventDefault()
  }

  const finishGesture = (): void => {
    clearLongPress()
    const current = drag.current
    drag.current = undefined
    if (current === undefined) return setDragOffset(undefined)
    if (!current.moved) {
      setDragOffset(undefined)
      return
    }
    setDragOffset(undefined)
    onOpenChange(offset.current < -TOTAL_ACTION_WIDTH_PX / 2)
    // The compatibility click can arrive in a later task than pointerup (mobile
    // browsers), so suppression lives until it is consumed or the next
    // pointerdown resets it. A timer here would let that late click close the
    // row again.
  }

  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!open) return
    event.preventDefault()
    event.stopPropagation()
    onOpenChange(false)
  }

  const translate = dragOffset ?? (open ? -TOTAL_ACTION_WIDTH_PX : 0)

  return (
    <div className="inbox-swipe-row" data-testid="inbox-swipe-row">
      <div
        className="inbox-swipe-row__actions"
        style={{ width: TOTAL_ACTION_WIDTH_PX }}
        aria-hidden={!open}
      >
        <button
          type="button"
          className="inbox-swipe-row__action inbox-swipe-row__action--close"
          data-testid="inbox-session-close-action"
          style={{ width: ACTION_WIDTH_PX }}
          tabIndex={open ? 0 : -1}
          disabled={disabled}
          onClick={onCloseSession}
        >
          {strings.sessionClose}
        </button>
        <button
          type="button"
          className="inbox-swipe-row__action inbox-swipe-row__action--remove"
          data-testid="inbox-session-remove-action"
          style={{ width: ACTION_WIDTH_PX }}
          tabIndex={open ? 0 : -1}
          disabled={disabled}
          onClick={onRemoveSession}
        >
          {strings.sessionRemove}
        </button>
      </div>
      <div
        className={`inbox-swipe-row__track${dragOffset !== undefined ? ' inbox-swipe-row__track--dragging' : ''}`}
        style={{ transform: `translateX(${translate}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
    </div>
  )
}
