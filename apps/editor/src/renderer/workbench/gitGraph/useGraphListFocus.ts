/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useGraphListFocus — the focus mirror behind the commit/change list's selection colour.
 *
 *  Rows carry `rowSelected` whether or not the list is focused; this hook only reports
 *  whether the listbox subtree holds DOM focus, and the stylesheet keys the active vs
 *  inactive fill off `[data-focused]` — the same expression the Explorer uses
 *  (ExplorerView.module.css `.view:not([data-focused='true'])`).
 *
 *  Spread the returned props on the focusable scroll container: they carry the ref, so do
 *  not also write `ref={...}` on that element. The caller's own ref object is written
 *  through, so `scrollRef.current` keeps working everywhere else.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState, type FocusEvent, type RefObject } from 'react'
import { isElementLike } from '@universe-editor/workbench-ui'

export interface GraphListFocusProps {
  /** `'true'` while the listbox subtree holds DOM focus; the row fill keys off it. */
  readonly 'data-focused': boolean
  readonly ref: (element: HTMLDivElement | null) => void
  readonly onFocus: () => void
  readonly onBlur: (event: FocusEvent<HTMLDivElement>) => void
}

export function useGraphListFocus(
  scrollRef: RefObject<HTMLDivElement | null>,
): GraphListFocusProps {
  const [hasFocus, setHasFocus] = useState(false)

  // Ref callback instead of an effect: the element identity changes whenever the editor
  // swaps the listbox out (loading state), and the reconcile has to run in that very
  // commit. It also covers the unmount side: the listbox is dropped while focused, and a
  // `focusout` from a detached node never reaches React's delegated listener — so without
  // this, `hasFocus` would stay stuck at true across the remount.
  const setContainer = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element
      setHasFocus(element !== null && element.contains(element.ownerDocument.activeElement))
    },
    [scrollRef],
  )

  const onFocus = useCallback(() => setHasFocus(true), [])

  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    // React's onBlur bubbles (focusout): moving focus onto a descendant — the listbox's
    // own "Load more" button — is still the list being focused.
    const next = event.relatedTarget
    if (isElementLike(next) && event.currentTarget.contains(next)) return
    setHasFocus(false)
  }, [])

  return { 'data-focused': hasFocus, ref: setContainer, onFocus, onBlur }
}
