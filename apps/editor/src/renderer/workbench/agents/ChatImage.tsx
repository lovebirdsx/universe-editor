/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChatImage — a single reusable image control shared by the prompt attachment
 *  chips and the message body. Renders an 88×88 thumbnail that preserves aspect
 *  ratio (object-fit: contain) and, on click, opens an anchored preview popover.
 *  The popover is portaled to <body> and positioned in viewport coordinates so it
 *  is never clipped by a scroll container and flips above/below + clamps
 *  horizontally when the thumbnail sits near a window edge. It supports
 *  wheel-zoom (cursor-anchored), drag-to-pan, double-click reset, and
 *  Esc / click-outside to dismiss.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { localize } from '@universe-editor/platform'
import styles from './agents.module.css'

export function ChatImage({
  src,
  alt,
  testId,
  mimeType,
}: {
  readonly src: string
  readonly alt: string
  readonly testId?: string
  readonly mimeType?: string
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLImageElement | null>(null)
  return (
    <span className={styles['chatImageWrap']}>
      <img
        ref={anchorRef}
        src={src}
        alt={alt}
        title={alt}
        className={styles['chatImageThumb']}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
        {...(testId ? { 'data-testid': testId } : {})}
        {...(mimeType ? { 'data-mime': mimeType } : {})}
      />
      {open ? (
        <ImagePreviewPopover
          src={src}
          alt={alt}
          anchorRef={anchorRef}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </span>
  )
}

interface Transform {
  readonly scale: number
  readonly x: number
  readonly y: number
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }
const MIN_SCALE = 0.2
const MAX_SCALE = 8
/** Gap between the thumbnail and the popover, and the min margin from any edge. */
const EDGE_GAP = 6
const VIEWPORT_MARGIN = 8

interface Placement {
  readonly left: number
  readonly top: number
}

function ImagePreviewPopover({
  src,
  alt,
  anchorRef,
  onDismiss,
}: {
  readonly src: string
  readonly alt: string
  readonly anchorRef: React.RefObject<HTMLImageElement | null>
  readonly onDismiss: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [t, setT] = useState<Transform>(IDENTITY)
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)

  // Position in viewport coordinates: prefer above the thumbnail, flip below when
  // there isn't room, and clamp horizontally so an edge-hugging thumbnail's
  // popover stays fully on screen instead of being clipped.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const popover = containerRef.current
    if (!anchor || !popover) return
    const a = anchor.getBoundingClientRect()
    const p = popover.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = a.top - EDGE_GAP - p.height
    if (top < VIEWPORT_MARGIN) {
      const below = a.bottom + EDGE_GAP
      // Use whichever side has more room if neither fully fits.
      top = below + p.height <= vh - VIEWPORT_MARGIN || below < a.top ? below : VIEWPORT_MARGIN
    }
    top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - p.height - VIEWPORT_MARGIN))

    let left = a.left
    left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - p.width - VIEWPORT_MARGIN))

    setPlacement({ left, top })
  }, [anchorRef, src])

  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      if (ev.target instanceof Node && anchorRef.current?.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    const handleReflow = () => onDismiss()
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
      // Closing on scroll/resize is simpler and less jarring than re-tracking
      // the anchor while the user pans the chat.
      window.addEventListener('resize', handleReflow)
      window.addEventListener('scroll', handleReflow, true)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', handleReflow)
      window.removeEventListener('scroll', handleReflow, true)
    }
  }, [anchorRef, onDismiss])

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    // Anchor the zoom at the cursor: keep the image point under the cursor fixed.
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    setT((prev) => {
      const factor = Math.exp(-e.deltaY * 0.0015)
      const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / prev.scale
      return {
        scale,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }
    })
  }, [])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: t.x,
        origY: t.y,
      }
    },
    [t.x, t.y],
  )

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    setT((prev) => ({
      ...prev,
      x: d.origX + (e.clientX - d.startX),
      y: d.origY + (e.clientY - d.startY),
    }))
  }, [])

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null
  }, [])

  return createPortal(
    <div
      ref={containerRef}
      className={styles['imagePreviewPopover']}
      data-testid="acp-image-preview-popover"
      role="dialog"
      aria-label={localize('acp.image.preview', 'Image preview')}
      style={
        placement
          ? { left: `${placement.left}px`, top: `${placement.top}px`, visibility: 'visible' }
          : // First layout pass renders off-screen-invisible so we can measure it.
            { left: '0px', top: '0px', visibility: 'hidden' }
      }
    >
      <div
        className={styles['imagePreviewStage']}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setT(IDENTITY)}
      >
        <img
          src={src}
          alt={alt}
          className={styles['imagePreviewImg']}
          draggable={false}
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
        />
      </div>
    </div>,
    document.body,
  )
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}
