/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownKeyboardNav — vimium-style scroll & history keys for the markdown
 *  preview (j/k line, h/l horizontal, d/u half-page, Space/Shift+Space full-page,
 *  gg/G top/bottom, H/L history back/forward). A numeric prefix repeats scrolls
 *  (`3j`). Parsing lives in the pure reduceNavKey reducer; this hook binds the
 *  listener and applies the resolved command to the live scroll container.
 *  (The `?` help toggle is a registered keybinding, not handled here.)
 *
 *  With the workbench Vim mode on, the container is also a `reader` Vim surface:
 *  j/k, gg/G, h/l, Ctrl+D/U and Ctrl+E/Y arrive through the shared `list.*`
 *  commands (with Vim counts) and drive the same `apply` below, so they match the
 *  editor; `NG` / `Ngg` scroll to markdown source line N (via `data-line`). A reader never swallows an unmapped key: `f`/`F` link hints, `?`,
 *  Ctrl+F, Esc, d/u/Space and H/L keep reaching the handlers above and the
 *  registered keybindings. Vim off = the surface is inert and nothing changes.
 *
 *  The listener sits on the container (bubble phase). Link hints, when active, own
 *  the keyboard at the document capture phase and stopPropagation, so these keys
 *  never reach here meanwhile — the two never fight. Keys routed by the global
 *  keybinding service (f/F open hints) are claimed in the capture phase before the
 *  event bubbles, so the reducer only ever sees the keys it owns.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import {
  useVimSurface,
  useVimSurfaceKey,
  type IVimSurfaceActions,
} from '@universe-editor/workbench-ui'
import { INITIAL_NAV_STATE, reduceNavKey, type NavCommand } from './markdownNavKeys.js'
import { isEditableTarget } from '../domUtils.js'
import { collectEntries, previewTopForLine } from './previewScrollMap.js'

/** Pixels per "line" for j/k — matches vimium's scrollStepSize default. */
const LINE_STEP = 60
/** Pixels per Ctrl+E / Ctrl+Y tick: one line of body text, not a vimium step. */
const VIEWPORT_STEP = 20

export interface MarkdownKeyboardNavCallbacks {
  goBack(): void
  goForward(): void
}

export function useMarkdownKeyboardNav<T extends HTMLElement>(
  rootRef: MutableRefObject<T | null>,
  callbacks: MarkdownKeyboardNavCallbacks,
  enabled: boolean,
): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const surfaceKey = useVimSurfaceKey('reader')
  const actions = useMemo(
    () => createReaderVimActions(() => rootRef.current, callbacksRef),
    [rootRef],
  )

  // Disabled while link hints own the keyboard, for Vim exactly like for the
  // legacy listener below.
  useVimSurface({
    id: surfaceKey,
    kind: 'reader',
    getElement: () => rootRef.current,
    getSurfaceKey: () => surfaceKey,
    defaultMode: 'normal',
    enabled,
    actions,
  })

  useEffect(() => {
    const el = rootRef.current
    if (!el || !enabled) return
    let state = INITIAL_NAV_STATE

    const onKeyDown = (e: KeyboardEvent): void => {
      // Yield to text-entry controls (the in-preview find box, any embedded
      // input): their bare characters mean "type", not "scroll". Without this
      // the reducer claims j/k/g/Space/digits and preventDefault()s them, so
      // those keys never land in the find input.
      if (isEditableTarget(e.target)) return
      // Leave modified chords (Ctrl/Alt/Meta) to keybindings; Shift is allowed
      // (it distinguishes Space/Shift+Space and the capital G/H/L keys).
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const result = reduceNavKey(state, e.key, e.shiftKey)
      state = result.state
      if (!result.handled) return
      e.preventDefault()
      if (result.command) apply(el, result.command, callbacksRef.current)
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [rootRef, enabled])
}

/** The `reader` surface contract: what `list.*` commands do on a markdown preview. */
export function createReaderVimActions(
  getElement: () => HTMLElement | null,
  callbacksRef: { readonly current: MarkdownKeyboardNavCallbacks },
): IVimSurfaceActions {
  const run = (command: NavCommand): void => {
    const el = getElement()
    if (el !== null) apply(el, command, callbacksRef.current)
  }
  return {
    move: (direction, count) => {
      if (direction === 'down') run({ type: 'scrollLine', dir: 1, count })
      else if (direction === 'up') run({ type: 'scrollLine', dir: -1, count })
      else run({ type: 'scrollHoriz', dir: direction === 'right' ? 1 : -1, count })
    },
    page: (direction, count) =>
      run({ type: 'scrollHalfPage', dir: direction === 'down' ? 1 : -1, count }),
    scrollViewport: (direction, count) =>
      run({ type: 'scrollViewport', dir: direction === 'down' ? 1 : -1, count }),
    // count 0 = none typed (`gg` / `G`); n >= 1 = source line n, like Vim's `nG`.
    first: (count) =>
      run(
        count >= 1 ? { type: 'scrollToLine', line: count, edge: 'first' } : { type: 'scrollToTop' },
      ),
    last: (count) =>
      run(
        count >= 1
          ? { type: 'scrollToLine', line: count, edge: 'last' }
          : { type: 'scrollToBottom' },
      ),
  }
}

export function apply(
  el: HTMLElement,
  command: NavCommand,
  cb: MarkdownKeyboardNavCallbacks,
): void {
  switch (command.type) {
    case 'scrollViewport':
      el.scrollBy({ top: command.dir * VIEWPORT_STEP * command.count })
      return
    case 'scrollLine':
      el.scrollBy({ top: command.dir * LINE_STEP * command.count, behavior: 'smooth' })
      return
    case 'scrollHoriz':
      el.scrollBy({ left: command.dir * LINE_STEP * command.count, behavior: 'smooth' })
      return
    case 'scrollHalfPage':
      el.scrollBy({ top: command.dir * el.clientHeight * 0.5 * command.count, behavior: 'smooth' })
      return
    case 'scrollFullPage':
      el.scrollBy({ top: command.dir * el.clientHeight, behavior: 'smooth' })
      return
    case 'scrollToTop':
      el.scrollTo({ top: 0, behavior: 'smooth' })
      return
    case 'scrollToBottom':
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      return
    case 'scrollToLine': {
      // Rendered blocks carry their 0-based source line in `data-line`; a preview
      // without any (plain docs) degrades to the gg / G edge.
      const entries = collectEntries(el)
      if (entries.length === 0) {
        el.scrollTo({ top: command.edge === 'first' ? 0 : el.scrollHeight, behavior: 'smooth' })
        return
      }
      el.scrollTo({ top: previewTopForLine(entries, command.line), behavior: 'smooth' })
      return
    }
    case 'goBack':
      cb.goBack()
      return
    case 'goForward':
      cb.goForward()
      return
  }
}
