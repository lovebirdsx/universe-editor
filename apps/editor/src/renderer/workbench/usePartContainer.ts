/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge between React refs and the platform `Part` instance.
 *
 *  Uses `useLayoutEffect` (not `useEffect`) so the Part's mount state advances
 *  synchronously after DOM commit but before any post-render effect runs. This
 *  closes the microsecond race where a sibling effect could call `part.focus()`
 *  while `mountState` still reads `unmounted`.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { IPart } from '@universe-editor/platform'

interface PartInternal {
  _attachContainer(el: HTMLElement | null): void
  _setFocusTarget(el: HTMLElement | null): void
}

function asInternal(part: IPart): PartInternal {
  return part as unknown as PartInternal
}

export function usePartContainer<E extends HTMLElement = HTMLDivElement>(
  part: IPart | undefined,
): RefObject<E | null> {
  const ref = useRef<E | null>(null)

  useLayoutEffect(() => {
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

export function usePartFocusTarget(part: IPart | undefined): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!part) return
    asInternal(part)._setFocusTarget(ref.current)
    return () => {
      asInternal(part)._setFocusTarget(null)
    }
  }, [part])

  return ref
}
