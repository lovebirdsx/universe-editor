/*---------------------------------------------------------------------------------------------
 *  useBackdropDismiss — click-outside-to-close for a modal backdrop that survives
 *  a drag whose press starts inside the dialog and releases over the backdrop
 *  (e.g. selecting text in an input, then dragging past its edge before letting
 *  go). A plain `onClick={dismiss}` closes in that case: the browser dispatches
 *  the click to the common ancestor of the mousedown and mouseup targets — the
 *  backdrop itself — so the click looks like a backdrop click. We instead track
 *  the press and dismiss on mouseup only when BOTH the press and the release land
 *  on the backdrop element (the handler's own currentTarget).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef, type MouseEvent } from 'react'

export interface BackdropDismissHandlers {
  onMouseDown: (e: MouseEvent<HTMLElement>) => void
  onMouseUp: (e: MouseEvent<HTMLElement>) => void
}

export function useBackdropDismiss(dismiss: () => void): BackdropDismissHandlers {
  const pressedOnBackdrop = useRef(false)

  const onMouseDown = useCallback((e: MouseEvent<HTMLElement>) => {
    pressedOnBackdrop.current = e.target === e.currentTarget
  }, [])

  const onMouseUp = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const shouldDismiss = pressedOnBackdrop.current && e.target === e.currentTarget
      pressedOnBackdrop.current = false
      if (shouldDismiss) dismiss()
    },
    [dismiss],
  )

  return { onMouseDown, onMouseUp }
}
