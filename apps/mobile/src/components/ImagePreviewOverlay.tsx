import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { strings } from '../strings.js'
import {
  IDENTITY_TRANSFORM,
  isDoubleTap,
  movedBeyondTolerance,
  panImage,
  shouldDismissByDrag,
  toggleDoubleTap,
  zoomAround,
  type ImageTransform,
} from './imageGesture.js'
import { useDocumentScrollLock } from './useDocumentScrollLock.js'

export interface ImagePreviewOverlayProps {
  readonly src: string
  readonly alt: string
  readonly onClose: () => void
}

interface Point {
  readonly x: number
  readonly y: number
}

/**
 * Full-screen image viewer: pinch to zoom, one-finger pan while zoomed,
 * double-tap 1x/2x, swipe down to dismiss. Portaled to <body> for the same
 * mobile-WebView reason as BottomSheet overlays.
 */
export function ImagePreviewOverlay({ src, alt, onClose }: ImagePreviewOverlayProps) {
  useDocumentScrollLock(true)
  const [transform, setTransform] = useState<ImageTransform>(IDENTITY_TRANSFORM)
  const [dragging, setDragging] = useState(false)
  const transformRef = useRef(transform)
  const pointers = useRef(new Map<number, Point>())
  const pinch = useRef<{ readonly distance: number; readonly scale: number } | undefined>(undefined)
  const gestureStart = useRef<Point | undefined>(undefined)
  const dismissDrag = useRef(0)
  const moved = useRef(false)
  const lastTap = useRef<
    { readonly at: number; readonly x: number; readonly y: number } | undefined
  >(undefined)
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const previousFocus = useRef<Element | null>(null)

  const applyTransform = (
    next: ImageTransform | ((current: ImageTransform) => ImageTransform),
  ): void => {
    const value = typeof next === 'function' ? next(transformRef.current) : next
    transformRef.current = value
    setTransform(value)
  }

  useEffect(() => {
    previousFocus.current = document.activeElement
    closeButton.current?.focus()
    return () => {
      const target = previousFocus.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // iOS Safari zooms the whole page on a two-finger gesture unless it is cancelled.
  useEffect(() => {
    const prevent = (event: Event): void => event.preventDefault()
    document.addEventListener('gesturestart', prevent)
    return () => document.removeEventListener('gesturestart', prevent)
  }, [])

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1) {
      gestureStart.current = { x: event.clientX, y: event.clientY }
      dismissDrag.current = 0
      moved.current = false
      setDragging(true)
      return
    }
    if (pointers.current.size === 2) {
      pinch.current = {
        distance: pointerDistance([...pointers.current.values()]),
        scale: transformRef.current.scale,
      }
      moved.current = true
    }
  }

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId)
    if (previous === undefined) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = [...pointers.current.values()]
    if (points.length >= 2) {
      const distance = pointerDistance(points)
      const centre = midpoint(points)
      const pinching = pinch.current
      if (pinching === undefined || pinching.distance <= 0) return
      applyTransform((current) =>
        zoomAround(
          current,
          pinching.scale * (distance / pinching.distance),
          centre.x - window.innerWidth / 2,
          centre.y - window.innerHeight / 2,
        ),
      )
      return
    }
    const start = gestureStart.current
    if (start === undefined) return
    if (movedBeyondTolerance(start, { x: event.clientX, y: event.clientY })) moved.current = true
    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    if (transformRef.current.scale > 1) {
      applyTransform((current) =>
        panImage(current, dx, dy, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      )
      return
    }
    const totalDy = event.clientY - start.y
    dismissDrag.current = Math.max(0, totalDy)
    applyTransform({ ...IDENTITY_TRANSFORM, y: dismissDrag.current })
  }

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointers.current.get(event.pointerId)
    pointers.current.delete(event.pointerId)
    if (pointers.current.size === 1) {
      pinch.current = undefined
      gestureStart.current = [...pointers.current.values()][0]
      return
    }
    if (pointers.current.size > 1) return
    pinch.current = undefined
    gestureStart.current = undefined
    setDragging(false)
    if (point === undefined) return
    if (!moved.current) {
      handleTap(point)
      return
    }
    if (transformRef.current.scale > 1) return
    const dy = dismissDrag.current
    dismissDrag.current = 0
    if (shouldDismissByDrag(dy)) {
      onClose()
      return
    }
    applyTransform(IDENTITY_TRANSFORM)
  }

  const handleTap = (point: Point): void => {
    const now = Date.now()
    const previous = lastTap.current
    const currentTap = { x: point.x, y: point.y }
    if (previous !== undefined && isDoubleTap(previous.at, now, previous, currentTap)) {
      lastTap.current = undefined
      applyTransform((current) =>
        toggleDoubleTap(current, point.x - window.innerWidth / 2, point.y - window.innerHeight / 2),
      )
      return
    }
    lastTap.current = { at: now, ...currentTap }
  }

  const pointerCancel = (): void => {
    pointers.current.clear()
    pinch.current = undefined
    gestureStart.current = undefined
    dismissDrag.current = 0
    setDragging(false)
    if (transformRef.current.scale === 1) applyTransform(IDENTITY_TRANSFORM)
  }

  const stageClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const dismissOpacity =
    transform.scale === 1 && transform.y > 0 ? Math.max(0.4, 1 - transform.y / 400) : 1
  const surface = (
    <div
      className="image-preview"
      data-testid="image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={strings.imagePreviewTitle}
    >
      <div
        className="image-preview__stage"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
        onClick={stageClick}
      >
        <img
          className={`image-preview__image${dragging ? ' image-preview__image--dragging' : ''}`}
          src={src}
          alt={alt}
          data-testid="image-preview-image"
          draggable={false}
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
            opacity: dismissOpacity,
          }}
        />
      </div>
      <button
        ref={closeButton}
        type="button"
        className="image-preview__close"
        data-testid="image-preview-close"
        aria-label={strings.imagePreviewClose}
        onClick={onClose}
      >
        ×
      </button>
      <p className="image-preview__hint" aria-hidden="true">
        {strings.imagePreviewGestureHint}
      </p>
    </div>
  )
  return createPortal(surface, document.body)
}

function pointerDistance(points: readonly Point[]): number {
  const first = points[0]
  const second = points[1]
  if (first === undefined || second === undefined) return 0
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function midpoint(points: readonly Point[]): Point {
  const first = points[0]
  const second = points[1]
  if (first === undefined || second === undefined) return { x: 0, y: 0 }
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
}
