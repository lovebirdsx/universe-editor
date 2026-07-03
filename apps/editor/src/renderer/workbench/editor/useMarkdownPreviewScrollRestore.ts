/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownPreviewScrollRestore — owns a markdown preview's scroll position:
 *  persists it on every user scroll (so a tab switch, which unmounts the preview,
 *  keeps it) and restores it on (re)mount. A pending one-shot reveal-line request
 *  (set when entering the preview aligned to the source cursor, or carried back
 *  from a link) wins over the saved scrollTop.
 *
 *  Split out of MarkdownPreviewEditor so the restore logic can be exercised under
 *  React StrictMode without standing up the whole markdown component tree. The
 *  reveal request is read *non-destructively* and cleared only once actually
 *  applied against laid-out content — the markdown renders asynchronously (so the
 *  first effect pass sees no `data-line` blocks) and StrictMode runs a throwaway
 *  setup→cleanup cycle first; a read-and-delete would let either swallow the
 *  request before it ever scrolls.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { MarkdownPreviewViewStateCache } from '../../services/editor/MarkdownPreviewViewStateCache.js'
import { collectEntries, previewTopForLine } from './previewScrollMap.js'

// How long to keep re-applying the restored scrollTop as content settles
// (mermaid renders serially, Monaco colorizes code fences late — both grow the
// document height after mount, clamping a one-shot restore against a too-short
// scrollHeight). Mirrors ChatBody's restore window.
const RESTORE_WINDOW_MS = 600

export function useMarkdownPreviewScrollRestore(
  rootRef: RefObject<HTMLElement | null>,
  stateKey: string,
): void {
  // True while re-applying a restored scrollTop, so onScroll doesn't treat the
  // programmatic scroll as a user action and overwrite the saved target.
  const restoringRef = useRef(false)

  // Persist scroll position on every scroll so a tab switch (which unmounts this
  // component) keeps it. Read the live DOM only while connected — a detached node
  // reports scrollTop 0, which would clobber the saved value on unmount.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onScroll = () => {
      if (restoringRef.current) return
      MarkdownPreviewViewStateCache.save(stateKey, { scrollTop: el.scrollTop })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [rootRef, stateKey])

  // Restore the saved scroll position on (re)mount — or, when entering the
  // preview (Ctrl+Shift+V / to the Side), scroll to the source file's cursor line
  // instead so the preview opens aligned to where the user was editing. Content
  // height grows asynchronously, so re-apply across a short window via
  // ResizeObserver until it settles or the user takes over.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    // A pending reveal-line request (set on preview open) wins over the saved
    // scrollTop. It's a source line, mapped to a pixel offset from the rendered
    // block positions, so it must be recomputed on every re-apply as blocks lay
    // out. Read it non-destructively (see the file header for why) and clear it
    // only once it has actually been applied against laid-out content.
    const revealLine = MarkdownPreviewViewStateCache.peekRevealLine(stateKey)
    const saved = MarkdownPreviewViewStateCache.load(stateKey)
    const hasReveal = revealLine !== undefined
    if (!hasReveal && (!saved || saved.scrollTop <= 0)) return
    restoringRef.current = true

    // Returns undefined for a reveal request until the preview blocks have laid
    // out, so we neither scroll to a bogus 0 nor clear the one-shot request early.
    const targetTop = (): number | undefined => {
      if (hasReveal) {
        const entries = collectEntries(el)
        if (entries.length === 0) return undefined
        return previewTopForLine(entries, revealLine)
      }
      return saved?.scrollTop ?? 0
    }

    const apply = () => {
      if (!restoringRef.current) return
      const target = targetTop()
      if (target === undefined) return
      if (el.scrollTop !== target) el.scrollTop = target
      // Applied against real laid-out content: consume the one-shot reveal so a
      // later re-mount falls back to the saved scrollTop instead of re-revealing.
      if (hasReveal) MarkdownPreviewViewStateCache.clearRevealLine(stateKey)
    }
    apply()

    const ro = new ResizeObserver(apply)
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)

    const timerRef: { id?: ReturnType<typeof setTimeout> } = {}
    const stop = () => {
      if (!restoringRef.current) return
      restoringRef.current = false
      ro.disconnect()
      if (timerRef.id !== undefined) clearTimeout(timerRef.id)
      el.removeEventListener('wheel', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('keydown', stop)
    }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    el.addEventListener('keydown', stop)
    timerRef.id = setTimeout(stop, RESTORE_WINDOW_MS)
    return stop
  }, [rootRef, stateKey])
}
