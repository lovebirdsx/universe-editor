/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge between React refs and the platform `Part` instance.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type RefObject } from 'react'
import type { IPart } from '@universe-editor/platform'

interface PartInternal {
  _attachContainer(el: HTMLElement | null): void
  _setFocusTarget(el: HTMLElement | null): void
}

function asInternal(part: IPart): PartInternal {
  return part as unknown as PartInternal
}

/**
 * Returns a ref to attach to the Part's root container element. The hook keeps
 * the Part's internal `_container` in sync with the React element: it attaches
 * on mount/update and detaches on unmount.
 */
export function usePartContainer<E extends HTMLElement = HTMLDivElement>(
  part: IPart | undefined,
): RefObject<E | null> {
  const ref = useRef<E | null>(null)

  useEffect(() => {
    if (!part) return
    const el = ref.current
    if (el) {
      asInternal(part)._attachContainer(el)
    }
    return () => {
      asInternal(part)._attachContainer(null)
    }
  }, [part])

  return ref
}

/**
 * Designate a focusable child element as the Part's focus target. The Part's
 * `focus()` will dispatch to this element (falling back to the container).
 */
export function usePartFocusTarget(part: IPart | undefined): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!part) return
    asInternal(part)._setFocusTarget(ref.current)
    return () => {
      asInternal(part)._setFocusTarget(null)
    }
  }, [part])

  return ref
}
