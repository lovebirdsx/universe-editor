import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export interface AutoGrowTextareaOptions {
  /** Border-box ceiling; keep in sync with the control's CSS max-height. */
  readonly maxHeightPx: number
}

/** `scrollHeight` excludes the border, while an inline height is border-box. */
export function clampAutoGrowHeight(
  scrollHeight: number,
  borderHeight: number,
  maxHeightPx: number,
): number {
  return Math.min(scrollHeight + borderHeight, maxHeightPx)
}

/**
 * Grows a textarea to its content up to `maxHeightPx`; past that the CSS
 * overflow takes over. The ref must be attached to the textarea.
 */
export function useAutoGrowTextarea(
  value: string,
  { maxHeightPx }: AutoGrowTextareaOptions,
): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const resize = useCallback(() => {
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    const borderHeight = element.offsetHeight - element.clientHeight
    element.style.height = `${clampAutoGrowHeight(
      element.scrollHeight,
      borderHeight,
      maxHeightPx,
    )}px`
    if (document.activeElement === element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' })
    }
  }, [maxHeightPx])

  // Content changes are the main trigger; layout-driven width changes are
  // caught by the resize listener below.
  useLayoutEffect(() => {
    resize()
    // `value` intentionally re-runs the measurement even though it is not read.
    void value
  }, [resize, value])

  useEffect(() => {
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [resize])

  return ref
}
