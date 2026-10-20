/*---------------------------------------------------------------------------------------------
 *  Sash — a draggable resize handle between two grid views.
 *
 *  The Sash captures the mouse on `mousedown`, listens to `mousemove` on
 *  `window`, and emits delta updates until `mouseup`. Cleanup is strict: any
 *  unmount during drag releases the global listeners and resets the global
 *  cursor.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import styles from './Sash.module.css'

export type SashOrientation = 'horizontal' | 'vertical'

export interface SashProps {
  /**
   * 'vertical' — a vertical bar between two horizontally arranged views;
   *   dragging it changes their widths (delta in x).
   * 'horizontal' — a horizontal bar between two vertically arranged views;
   *   dragging it changes their heights (delta in y).
   */
  orientation: SashOrientation
  onStart?: () => void
  onResize: (delta: number) => void
  onEnd?: () => void
  /** Optional inline style (e.g. for absolute positioning by the grid layout). */
  style?: CSSProperties
}

export function Sash({ orientation, onStart, onResize, onEnd, style }: SashProps) {
  const [active, setActive] = useState(false)
  const startRef = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startRef.current = orientation === 'vertical' ? e.clientX : e.clientY
      setActive(true)
      onStart?.()
    },
    [orientation, onStart],
  )

  useEffect(() => {
    if (!active) return
    const onMove = (e: MouseEvent) => {
      const current = orientation === 'vertical' ? e.clientX : e.clientY
      const delta = current - startRef.current
      startRef.current = current
      if (delta !== 0) onResize(delta)
    }
    const onUp = () => {
      setActive(false)
      onEnd?.()
    }
    const cursor = orientation === 'vertical' ? 'ew-resize' : 'ns-resize'
    // A sash can live in an auxiliary window's document; drive that document's
    // body and window listeners, not the main window's.
    const doc = containerRef.current?.ownerDocument ?? document
    const view = doc.defaultView ?? window
    const prevCursor = doc.body.style.cursor
    const prevUserSelect = doc.body.style.userSelect
    doc.body.style.cursor = cursor
    doc.body.style.userSelect = 'none'
    view.addEventListener('mousemove', onMove)
    view.addEventListener('mouseup', onUp)
    return () => {
      view.removeEventListener('mousemove', onMove)
      view.removeEventListener('mouseup', onUp)
      doc.body.style.cursor = prevCursor
      doc.body.style.userSelect = prevUserSelect
    }
  }, [active, orientation, onResize, onEnd])

  const className = `${styles['sash']} ${styles[orientation] ?? ''} ${active ? (styles['active'] ?? '') : ''}`

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={orientation}
    />
  )
}
