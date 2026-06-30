/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownKeyboardNav — vimium-style scroll & history keys for the markdown
 *  preview (j/k line, h/l horizontal, d/u half-page, Space/Shift+Space full-page,
 *  gg/G top/bottom, H/L history back/forward, ? help). A numeric prefix repeats
 *  scrolls (`3j`). Parsing lives in the pure reduceNavKey reducer; this hook binds
 *  the listener and applies the resolved command to the live scroll container.
 *
 *  The listener sits on the container (bubble phase). Link hints, when active, own
 *  the keyboard at the document capture phase and stopPropagation, so these keys
 *  never reach here meanwhile — the two never fight. Keys routed by the global
 *  keybinding service (f/F open hints) are claimed in the capture phase before the
 *  event bubbles, so the reducer only ever sees the keys it owns.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type MutableRefObject } from 'react'
import { INITIAL_NAV_STATE, reduceNavKey, type NavCommand } from './markdownNavKeys.js'

/** Pixels per "line" for j/k — matches vimium's scrollStepSize default. */
const LINE_STEP = 60

export interface MarkdownKeyboardNavCallbacks {
  goBack(): void
  goForward(): void
  toggleHelp(): void
}

export function useMarkdownKeyboardNav<T extends HTMLElement>(
  rootRef: MutableRefObject<T | null>,
  callbacks: MarkdownKeyboardNavCallbacks,
  enabled: boolean,
): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    const el = rootRef.current
    if (!el || !enabled) return
    let state = INITIAL_NAV_STATE

    const onKeyDown = (e: KeyboardEvent): void => {
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

function apply(el: HTMLElement, command: NavCommand, cb: MarkdownKeyboardNavCallbacks): void {
  switch (command.type) {
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
    case 'goBack':
      cb.goBack()
      return
    case 'goForward':
      cb.goForward()
      return
    case 'toggleHelp':
      cb.toggleHelp()
      return
  }
}
