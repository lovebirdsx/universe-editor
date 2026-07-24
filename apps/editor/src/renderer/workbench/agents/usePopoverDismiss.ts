/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  usePopoverDismiss — shared dismiss behavior for the prompt-action popovers:
 *  pointer-down outside the container or Escape closes. Listener attachment is
 *  deferred one frame so the same click that opened the popover doesn't
 *  immediately dismiss it.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, type RefObject } from 'react'

export function usePopoverDismiss(
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [containerRef, onDismiss])
}
