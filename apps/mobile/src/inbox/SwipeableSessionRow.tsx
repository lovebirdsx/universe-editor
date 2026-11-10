import { useEffect, useRef, useState, type ReactNode } from 'react'
import { strings } from '../strings.js'

const ACTION_WIDTH_PX = 76
const TOTAL_ACTION_WIDTH_PX = ACTION_WIDTH_PX * 2
// Open once the first action is half revealed, like a native swipe row. The
// old half-of-total threshold (76px) made ordinary swipes snap back.
const OPEN_THRESHOLD_PX = ACTION_WIDTH_PX / 2
const LONG_PRESS_MS = 500
const SWIPE_START_PX = 8
// A thumb swiping left arcs downwards first, so the horizontal span is often
// smaller than the vertical one in the opening frames. Bias the direction lock
// towards horizontal or the browser's vertical pan wins before the row moves.
const HORIZONTAL_BIAS = 0.5
// The browser starts a vertical pan around its ~8px touch slop. Decide before
// that: waiting for a larger threshold lets the browser cancel diagonal swipes
// before JS can claim the sequence.
const TOUCH_LOCK_PX = 6
const FLICK_PROJECTION_MS = 100
const FLICK_MIN_DISTANCE_PX = 16
const FLICK_MIN_VELOCITY = 0.25
const FLICK_MAX_VELOCITY = 3
const VELOCITY_WINDOW_MS = 120
const VELOCITY_MIN_DT_MS = 8
// Holding still before lifting must not count as a flick. The release point is
// also skipped when it did not move past the last sample: it would only add
// rest time and dilute the release speed.
const VELOCITY_REST_MS = 80
const MAX_VELOCITY_SAMPLES = 10

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

interface MoveSample {
  readonly x: number
  readonly t: number
}

interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly base: number
  moved: boolean
  readonly samples: MoveSample[]
}

const horizontalIntent = (dx: number, dy: number, slop: number): boolean =>
  Math.abs(dx) > slop && Math.abs(dx) >= Math.abs(dy) * HORIZONTAL_BIAS

const verticalIntent = (dx: number, dy: number, slop: number): boolean =>
  Math.abs(dy) > slop && Math.abs(dx) < Math.abs(dy) * HORIZONTAL_BIAS

const clampOffset = (value: number): number => Math.max(-TOTAL_ACTION_WIDTH_PX, Math.min(0, value))

/** Release speed in px/ms over the last gesture window. */
const releaseVelocity = (samples: readonly MoveSample[]): number => {
  const last = samples[samples.length - 1]
  if (last === undefined) return 0
  let first = last
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]
    if (sample === undefined || last.t - sample.t > VELOCITY_WINDOW_MS) break
    first = sample
  }
  const dt = last.t - first.t
  if (dt < VELOCITY_MIN_DT_MS) return 0
  return Math.max(-FLICK_MAX_VELOCITY, Math.min(FLICK_MAX_VELOCITY, (last.x - first.x) / dt))
}

/**
 * iOS-style row: swipe left to reveal close/remove, long-press for the same
 * actions. Horizontal touch gestures must actively claim the sequence from the
 * browser's vertical pan, otherwise a diagonal (thumb) swipe is cancelled
 * before the row has moved.
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
  const trackRef = useRef<HTMLDivElement | null>(null)

  useEffect(
    () => () => {
      if (longPressTimer.current !== undefined) clearTimeout(longPressTimer.current)
    },
    [],
  )

  useEffect(() => {
    const track = trackRef.current
    if (track === null || disabled) return
    let startX = 0
    let startY = 0
    let tracking = false
    let intent: 'horizontal' | 'vertical' | undefined

    const onTouchStart = (event: TouchEvent): void => {
      intent = undefined
      tracking = event.touches.length === 1
      const touch = event.touches[0]
      if (touch !== undefined) {
        startX = touch.clientX
        startY = touch.clientY
      }
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch === undefined) return
      if (intent === 'horizontal') {
        // Keep claiming every move: a single cancelled touchmove only stops
        // scrolling for that event in some browsers.
        if (event.cancelable) event.preventDefault()
        return
      }
      if (intent === 'vertical') return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (horizontalIntent(dx, dy, TOUCH_LOCK_PX)) {
        intent = 'horizontal'
        if (event.cancelable) event.preventDefault()
      } else if (verticalIntent(dx, dy, TOUCH_LOCK_PX)) {
        intent = 'vertical'
      }
    }

    const reset = (): void => {
      tracking = false
      intent = undefined
    }

    track.addEventListener('touchstart', onTouchStart, { passive: true })
    // Non-passive is required: pointer events cannot cancel the browser's pan,
    // only preventDefault on touchmove can.
    track.addEventListener('touchmove', onTouchMove, { passive: false })
    track.addEventListener('touchend', reset)
    track.addEventListener('touchcancel', reset)
    return () => {
      track.removeEventListener('touchstart', onTouchStart)
      track.removeEventListener('touchmove', onTouchMove)
      track.removeEventListener('touchend', reset)
      track.removeEventListener('touchcancel', reset)
    }
  }, [disabled])

  const clearLongPress = (): void => {
    if (longPressTimer.current === undefined) return
    clearTimeout(longPressTimer.current)
    longPressTimer.current = undefined
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return
    // The second finger of a two-finger gesture must not reset the drag.
    if (event.pointerType === 'touch' && !event.isPrimary) return
    onGestureStart()
    // A pointerup can land off-track (mouse long-press opens the sheet), so the
    // next gesture must clear the stale click suppression itself. Clearing the
    // timer also stops a second finger from leaving the first long-press armed.
    clearLongPress()
    suppressClick.current = false
    const base = open ? -TOTAL_ACTION_WIDTH_PX : 0
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base,
      moved: false,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    }
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
    if (current === undefined || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.moved) {
      if (verticalIntent(dx, dy, SWIPE_START_PX)) {
        clearLongPress()
        return
      }
      if (!horizontalIntent(dx, dy, SWIPE_START_PX)) return
      current.moved = true
      clearLongPress()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    suppressClick.current = true
    offset.current = clampOffset(current.base + dx)
    setDragOffset(offset.current)
    current.samples.push({ x: event.clientX, t: event.timeStamp })
    if (current.samples.length > MAX_VELOCITY_SAMPLES) current.samples.shift()
    if (event.cancelable) event.preventDefault()
  }

  const finishGesture = (event: React.PointerEvent<HTMLDivElement>): void => {
    clearLongPress()
    const current = drag.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    drag.current = undefined
    const cancelled = event.type === 'pointercancel'
    if (!cancelled && !current.moved) {
      // A fast flick can lose the pointermove that crosses the slop (coalesced
      // frames); the release point still proves a horizontal intent.
      const dx = event.clientX - current.startX
      const dy = event.clientY - current.startY
      if (!horizontalIntent(dx, dy, SWIPE_START_PX)) {
        setDragOffset(undefined)
        return
      }
      current.moved = true
      suppressClick.current = true
    }
    const lastSample = current.samples[current.samples.length - 1]
    const rested = lastSample !== undefined && event.timeStamp - lastSample.t > VELOCITY_REST_MS
    if (!cancelled) {
      // The last segment between the final pointermove and the release is not
      // reported separately; count the release point itself.
      offset.current = clampOffset(current.base + event.clientX - current.startX)
      // Skip a release that did not move past the last sample: it would only
      // add rest time and dilute the release speed.
      if (!rested && lastSample !== undefined && Math.abs(event.clientX - lastSample.x) >= 1) {
        current.samples.push({ x: event.clientX, t: event.timeStamp })
      }
    }
    const velocity = cancelled || rested ? 0 : releaseVelocity(current.samples)
    const projected =
      Math.abs(offset.current) >= FLICK_MIN_DISTANCE_PX && Math.abs(velocity) >= FLICK_MIN_VELOCITY
        ? clampOffset(offset.current + velocity * FLICK_PROJECTION_MS)
        : offset.current
    setDragOffset(undefined)
    onOpenChange(projected <= -OPEN_THRESHOLD_PX)
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
        ref={trackRef}
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
