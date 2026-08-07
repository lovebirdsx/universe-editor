/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  TooltipProvider — the single tooltip surface for the whole workbench.
 *  A global event delegation replaces the native `title` attribute: any element
 *  carrying `data-tooltip="…"` gets a themed tooltip after a hover/focus delay.
 *  Elements carrying a plain `title` attribute (Monaco hover links, third-party
 *  widgets, stray JSX) get the same themed tooltip instead of the OS-native one:
 *  the attribute is stashed while hovered (suppressing the native bubble) and
 *  restored afterwards so accessibility tooling still sees it.
 *  Rendered through Floating UI anchored to the element (top, flipping below when
 *  there is no room), styled by tooltipSurface.module.css so it matches the rest
 *  of the overlay family (menu / dialog / popover).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useFloating, autoUpdate, offset, flip, shift, FloatingPortal } from '@floating-ui/react'
import styles from './tooltipSurface.module.css'

export const TOOLTIP_ATTRIBUTE = 'data-tooltip'

/** Where a native `title` is stashed while the themed tooltip stands in for it. */
const NATIVE_TITLE_STASH = 'data-tooltip-native-title'

const REOPEN_WINDOW_MS = 200
const FOCUS_SUPPRESS_AFTER_MOUSEDOWN_MS = 350
const DETACHED_CHECK_INTERVAL_MS = 500

interface TooltipState {
  target: Element
  text: string
}

export interface TooltipProviderProps {
  /** Hover/focus delay in ms before the tooltip appears. Defaults to 500. */
  delay?: number
  children?: ReactNode
}

/** Elements whose `title` carries semantics the tooltip must not stand in for
 *  (an iframe's title names the frame for assistive tech). */
const NATIVE_TITLE_EXCLUDED_TAGS = new Set(['IFRAME', 'WEBVIEW'])

/** Suppress the OS-native tooltip by moving `title` aside; the stash attribute
 *  keeps the element matching future `closest` lookups for the same hover. */
function claimNativeTitle(el: Element): void {
  if (NATIVE_TITLE_EXCLUDED_TAGS.has(el.tagName)) return
  const title = el.getAttribute('title')
  if (title === null || el.hasAttribute(NATIVE_TITLE_STASH)) return
  el.setAttribute(NATIVE_TITLE_STASH, title)
  el.removeAttribute('title')
}

function restoreNativeTitle(el: Element): void {
  const stashed = el.getAttribute(NATIVE_TITLE_STASH)
  if (stashed === null) return
  el.removeAttribute(NATIVE_TITLE_STASH)
  el.setAttribute('title', stashed)
}

function tooltipTargetFrom(node: EventTarget | null): { target: Element; text: string } | null {
  if (!(node instanceof Element)) return null
  const el = node.closest(`[${TOOLTIP_ATTRIBUTE}],[${NATIVE_TITLE_STASH}],[title]`)
  if (!el) return null
  // A native `title` on the resolved element would pop the OS bubble alongside
  // ours — claim it even when `data-tooltip` wins the text.
  claimNativeTitle(el)
  const text = (
    el.getAttribute(TOOLTIP_ATTRIBUTE) ??
    el.getAttribute(NATIVE_TITLE_STASH) ??
    ''
  ).trim()
  return text ? { target: el, text } : null
}

export function TooltipProvider({ delay = 500, children }: TooltipProviderProps) {
  const [tip, setTip] = useState<TooltipState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipRef = useRef<TooltipState | null>(null)
  const lastHideAtRef = useRef(0)
  const lastMouseDownAtRef = useRef(0)

  tipRef.current = tip

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    const hide = () => {
      clear()
      if (tipRef.current !== null) {
        restoreNativeTitle(tipRef.current.target)
        lastHideAtRef.current = Date.now()
      }
      setTip(null)
    }
    const show = (next: TooltipState) => {
      clear()
      // Chain behavior: while a tooltip is visible (or just dismissed), moving to
      // another tooltip host shows it instantly instead of waiting out the delay.
      // Nested hosts (parent/child both titled) switch without a mouseout, so the
      // previous host's native title is restored here rather than in hide().
      const instant =
        tipRef.current !== null || Date.now() - lastHideAtRef.current < REOPEN_WINDOW_MS
      if (tipRef.current !== null && tipRef.current.target !== next.target) {
        restoreNativeTitle(tipRef.current.target)
      }
      if (instant) {
        setTip(next)
      } else {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setTip(next)
        }, delay)
      }
    }

    const onMouseOver = (e: MouseEvent) => {
      const next = tooltipTargetFrom(e.target)
      if (!next) return
      if (tipRef.current?.target === next.target && tipRef.current.text === next.text) return
      show(next)
    }
    const onMouseOut = (e: MouseEvent) => {
      const current = tipRef.current
      if (!current) {
        clear()
        return
      }
      const movingTo = e.relatedTarget
      if (movingTo instanceof Node && current.target.contains(movingTo)) return
      hide()
    }
    const onFocusIn = (e: FocusEvent) => {
      // Clicking focuses the element too; the mouse handlers own that scenario.
      if (Date.now() - lastMouseDownAtRef.current < FOCUS_SUPPRESS_AFTER_MOUSEDOWN_MS) return
      const next = tooltipTargetFrom(e.target)
      if (next) show(next)
    }
    const onFocusOut = () => hide()
    const onMouseDown = () => {
      lastMouseDownAtRef.current = Date.now()
      hide()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }

    document.addEventListener('mouseover', onMouseOver)
    document.addEventListener('mouseout', onMouseOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('wheel', hide, true)
    return () => {
      clear()
      document.removeEventListener('mouseover', onMouseOver)
      document.removeEventListener('mouseout', onMouseOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('wheel', hide, true)
    }
  }, [delay])

  // The host element can be unmounted by React while its tooltip is visible
  // (list re-render, tree collapse, …) — no mouseout fires in that case.
  useEffect(() => {
    if (!tip) return
    const id = setInterval(() => {
      if (!tip.target.isConnected) setTip(null)
    }, DETACHED_CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [tip])

  return (
    <>
      {children}
      {tip ? <TooltipSurface target={tip.target} text={tip.text} /> : null}
    </>
  )
}

function TooltipSurface({ target, text }: TooltipState) {
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'top',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  useEffect(() => {
    refs.setReference(target)
  }, [refs, target])

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        role="tooltip"
        className={styles['tooltipSurface']}
        style={floatingStyles}
      >
        {text}
      </div>
    </FloatingPortal>
  )
}
