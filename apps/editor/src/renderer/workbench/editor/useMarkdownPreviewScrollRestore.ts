/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownPreviewScrollRestore — owns a markdown preview's scroll position:
 *  persists it on every user scroll (so a tab switch, which unmounts the preview,
 *  keeps it) and restores it on (re)mount. A pending one-shot reveal request —
 *  an anchor fragment carried by a cross-file link, or a source line set when
 *  entering the preview aligned to the source cursor — wins over the saved
 *  scrollTop. This hook is the single owner of the mount-time landing position;
 *  routing the anchor through it (rather than a separate scrollIntoView) is what
 *  keeps the restored scrollTop from overwriting a freshly requested anchor.
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
import { findMarkdownAnchor } from '../markdown/markdownAnchors.js'
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

  // Restore the saved scroll position on (re)mount — or, when a one-shot reveal
  // request is pending (an anchor from a cross-file link, or the source cursor
  // line when entering the preview), scroll there instead. Content height grows
  // asynchronously, so re-apply across a short window via ResizeObserver until
  // it settles or the user takes over.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    // Pending reveal requests win over the saved scrollTop: anchor first (the
    // most recent navigation intent), then reveal line. Both are read
    // non-destructively (see the file header for why) and cleared only once
    // actually applied against laid-out content. They are recomputed on every
    // re-apply as blocks lay out, since their pixel position moves while late
    // content (mermaid, code colorization) grows the document.
    const revealAnchor = MarkdownPreviewViewStateCache.peekRevealAnchor(stateKey)
    const revealLine =
      revealAnchor === undefined
        ? MarkdownPreviewViewStateCache.peekRevealLine(stateKey)
        : undefined
    const saved = MarkdownPreviewViewStateCache.load(stateKey)
    const hasReveal = revealAnchor !== undefined || revealLine !== undefined
    if (!hasReveal && (!saved || saved.scrollTop <= 0)) return
    restoringRef.current = true

    // Set once the content has laid out but the anchor isn't in it (stale or
    // mistyped fragment): drop the one-shot and fall back to the saved scrollTop.
    let anchorMissing = false

    // Returns undefined for a reveal request until the preview blocks have laid
    // out, so we neither scroll to a bogus 0 nor clear the one-shot request early.
    const targetTop = (): number | undefined => {
      if (revealAnchor !== undefined && !anchorMissing) {
        const target = findMarkdownAnchor(el, revealAnchor)
        if (target) {
          return target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
        }
        if (collectEntries(el).length === 0) return undefined
        anchorMissing = true
        MarkdownPreviewViewStateCache.clearRevealAnchor(stateKey)
      }
      if (revealLine !== undefined) {
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
      // Applied against real laid-out content: consume the one-shot so a later
      // re-mount falls back to the saved scrollTop instead of re-revealing, and
      // fold the landing into the saved position so a plain tab switch returns
      // here rather than to the pre-reveal offset.
      if (hasReveal && !anchorMissing) {
        MarkdownPreviewViewStateCache.save(stateKey, { scrollTop: target })
        MarkdownPreviewViewStateCache.clearRevealAnchor(stateKey)
        MarkdownPreviewViewStateCache.clearRevealLine(stateKey)
      }
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
