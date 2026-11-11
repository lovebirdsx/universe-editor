/** Pure gesture math for the full-screen image viewer (no DOM access). */

export interface ImageTransform {
  readonly scale: number
  readonly x: number
  readonly y: number
}

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export const MIN_IMAGE_SCALE = 1
export const MAX_IMAGE_SCALE = 4
export const DOUBLE_TAP_SCALE = 2
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_DISTANCE_PX = 24
export const DISMISS_DRAG_PX = 120
const MOVE_TOLERANCE_PX = 4

export const IDENTITY_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 }

export function clampImageScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_IMAGE_SCALE
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale))
}

/**
 * Scale around a screen point (relative to the viewport centre) so the content
 * under the anchor stays put: `x' = a - (a - x) * s' / s`.
 */
export function zoomAround(
  transform: ImageTransform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
): ImageTransform {
  const scale = clampImageScale(nextScale)
  const ratio = scale / transform.scale
  return {
    scale,
    x: anchorX - (anchorX - transform.x) * ratio,
    y: anchorY - (anchorY - transform.y) * ratio,
  }
}

/** Translate within the scaled overflow so the image never leaves the stage. */
export function panImage(
  transform: ImageTransform,
  dx: number,
  dy: number,
  viewport: ViewportSize,
): ImageTransform {
  const maxX = Math.max(0, ((transform.scale - 1) * viewport.width) / 2)
  const maxY = Math.max(0, ((transform.scale - 1) * viewport.height) / 2)
  return {
    ...transform,
    x: clamp(transform.x + dx, -maxX, maxX),
    y: clamp(transform.y + dy, -maxY, maxY),
  }
}

/** Double tap toggles between fit (1x) and {@link DOUBLE_TAP_SCALE}, zoomed at the tap. */
export function toggleDoubleTap(
  transform: ImageTransform,
  anchorX: number,
  anchorY: number,
): ImageTransform {
  if (transform.scale > MIN_IMAGE_SCALE) return IDENTITY_TRANSFORM
  return zoomAround(transform, DOUBLE_TAP_SCALE, anchorX, anchorY)
}

export function shouldDismissByDrag(deltaY: number): boolean {
  return deltaY >= DISMISS_DRAG_PX
}

/** Whether the tap at `now` is the second half of a double tap. */
export function isDoubleTap(
  previousTapAt: number | undefined,
  now: number,
  previousTap?: { readonly x: number; readonly y: number },
  currentTap?: { readonly x: number; readonly y: number },
): boolean {
  if (previousTapAt === undefined) return false
  if (now - previousTapAt > DOUBLE_TAP_MS) return false
  if (previousTap === undefined || currentTap === undefined) return true
  return (
    Math.hypot(currentTap.x - previousTap.x, currentTap.y - previousTap.y) <= DOUBLE_TAP_DISTANCE_PX
  )
}

export function movedBeyondTolerance(
  start: { readonly x: number; readonly y: number },
  current: { readonly x: number; readonly y: number },
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > MOVE_TOLERANCE_PX
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
